/**
 * Optional on-chain record of the agent's rules and fills in WaypointStrategyLog.
 *
 * Active only when a contract address is configured (env HASHKEY_STRATEGY_LOG, or hashkey/deployed.json).
 * Without one every function here is a no-op, so the agent behaves exactly as before. Writes are signed by
 * the agent's own execution wallet through the same signing path as its trades, run in the background after
 * the trade is already recorded, and swallow their own errors: a failed log write can never block or undo a trade.
 *
 * Mapping onto the contract (it stores stop-loss / take-profit rules): one strategy per asset, registered with
 * token = the asset's ERC-20, quoteToken = USDT, stopLossPrice = pool price at registration x (1 - stopLossPct),
 * takeProfitPrice = reference price at registration x (1 - exitDiscountPct), sellBps = 10000 (the agent closes whole
 * positions). Paper mode has no signing wallet and touches nothing on-chain: rules are registered and fills recorded in live mode only.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, parseAbi, parseUnits, type Account } from "viem";
import { getDb } from "../accounts/store.js";
import { hashkey } from "../chains/hashkey.js";
import { pendingNonce, walletClientFor } from "../execution/shared.js";
import { ASSETS, USDT, USDT_DECIMALS, type Reading } from "./market.js";
import type { AssetSymbol, StrategyConfig } from "./strategy.js";

export const STRATEGY_LOG_ABI = parseAbi([
  "function registerStrategy(address token, address quoteToken, uint256 stopLossPrice, uint256 takeProfitPrice, uint16 sellBps) returns (uint256 id)",
  "function recordExecution(uint256 id, bool takeProfit, uint256 amountIn, uint256 amountOut, bytes32 txHash)",
  "function stopStrategy(uint256 id)",
  "event StrategyRegistered(uint256 indexed id, address indexed owner, address token, address quoteToken, uint256 stopLossPrice, uint256 takeProfitPrice, uint16 sellBps)",
]);

const here = dirname(fileURLToPath(import.meta.url));
export const EXPLORER_TX = "https://hashkey.blockscout.com/tx/";

/** The configured contract, or null when the agent should not touch the chain log. */
export function chainLogAddress(): `0x${string}` | null {
  const fromEnv = process.env.HASHKEY_STRATEGY_LOG?.trim();
  if (fromEnv) return getAddress(fromEnv);
  const file = join(here, "deployed.json");
  if (!existsSync(file)) return null;
  try {
    const { address } = JSON.parse(readFileSync(file, "utf8")) as { address?: string };
    return address ? getAddress(address) : null;
  } catch {
    return null;
  }
}

// ---- calldata (pure, used by the writers and by the dry-run test) -------------------------------------------

const units = (n: number, decimals: number): bigint => parseUnits(n.toFixed(Math.min(decimals, 8)), decimals);

export function registerCalldata(asset: AssetSymbol, config: StrategyConfig, reading: Pick<Reading, "poolPrice" | "refPrice">): `0x${string}` {
  const stop = units(reading.poolPrice * (1 - config.stopLossPct / 100), USDT_DECIMALS);
  let take = units(reading.refPrice * (1 - config.exitDiscountPct / 100), USDT_DECIMALS);
  if (take <= stop) take = stop + 1n; // the contract wants stop < take; the rule's own thresholds are in the agent's config
  return encodeFunctionData({ abi: STRATEGY_LOG_ABI, functionName: "registerStrategy", args: [ASSETS[asset].address, USDT, stop, take, 10_000] });
}

export function recordCalldata(strategyId: bigint, fill: { side: "buy" | "sell"; usdt: number; qty: number; decimals: number; txHash: string; takeProfit: boolean }): `0x${string}` {
  const qty = units(fill.qty, fill.decimals);
  const usdt = units(fill.usdt, USDT_DECIMALS);
  const [amountIn, amountOut] = fill.side === "buy" ? [usdt, qty] : [qty, usdt];
  return encodeFunctionData({ abi: STRATEGY_LOG_ABI, functionName: "recordExecution", args: [strategyId, fill.takeProfit, amountIn, amountOut, fill.txHash as `0x${string}`] });
}

export function stopCalldata(strategyId: bigint): `0x${string}` {
  return encodeFunctionData({ abi: STRATEGY_LOG_ABI, functionName: "stopStrategy", args: [strategyId] });
}

// ---- bookkeeping ---------------------------------------------------------------------------------------------

let ready = false;
function db() {
  if (!ready) {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS hsk_chain_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_id TEXT NOT NULL,
        asset TEXT NOT NULL,
        kind TEXT NOT NULL,
        strategy_id TEXT,
        trade_id INTEGER,
        tx_hash TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hsk_chain_trigger ON hsk_chain_log(trigger_id, ts);
    `);
    ready = true;
  }
  return getDb();
}

function addLog(row: { triggerId: string; asset: string; kind: "register" | "record" | "stop"; strategyId?: bigint; tradeId?: number; txHash: string }): void {
  db()
    .prepare(`INSERT INTO hsk_chain_log (trigger_id, asset, kind, strategy_id, trade_id, tx_hash, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.triggerId, row.asset, row.kind, row.strategyId?.toString() ?? null, row.tradeId ?? null, row.txHash, Math.floor(Date.now() / 1000));
}

/** The contract strategy id for an asset, if its rule is registered and not stopped. */
function activeStrategyId(triggerId: string, asset: string): bigint | null {
  const row = db()
    .prepare(`SELECT kind, strategy_id FROM hsk_chain_log WHERE trigger_id = ? AND asset = ? AND kind IN ('register', 'stop') ORDER BY id DESC LIMIT 1`)
    .get(triggerId, asset) as { kind: string; strategy_id: string | null } | undefined;
  return row?.kind === "register" && row.strategy_id !== null ? BigInt(row.strategy_id) : null;
}

export interface ChainLogEntry {
  kind: "register" | "record" | "stop";
  asset: string;
  tradeId: number | null;
  txHash: string;
  ts: number;
}

export function listChainLog(triggerId: string, limit = 50): ChainLogEntry[] {
  const rows = db().prepare(`SELECT kind, asset, trade_id, tx_hash, ts FROM hsk_chain_log WHERE trigger_id = ? ORDER BY id DESC LIMIT ?`).all(triggerId, limit) as Array<{ kind: ChainLogEntry["kind"]; asset: string; trade_id: number | null; tx_hash: string; ts: number }>;
  return rows.map((r) => ({ kind: r.kind, asset: r.asset, tradeId: r.trade_id, txHash: r.tx_hash, ts: r.ts }));
}

// ---- sending -------------------------------------------------------------------------------------------------

const client = createPublicClient({ chain: hashkey.viemChain, transport: http(hashkey.publicRpc) });
/** One write at a time per wallet, so log writes never race each other (or a trade) for a nonce. */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(account: Account, job: () => Promise<T>): Promise<T | null> {
  const key = account.address.toLowerCase();
  const run = (queues.get(key) ?? Promise.resolve()).then(job).catch((err) => {
    console.error("[hashkey] chain log write skipped:", err instanceof Error ? err.message : err);
    return null;
  });
  queues.set(key, run);
  return run as Promise<T | null>;
}

async function send(account: Account, to: `0x${string}`, data: `0x${string}`) {
  await client.call({ account: account.address, to, data }); // simulate first: a revert costs nothing
  const gas = await client.estimateGas({ account: account.address, to, data });
  const hash = await walletClientFor(account, "hashkey").sendTransaction({ to, data, gas: (gas * 130n) / 100n, nonce: await pendingNonce("hashkey", account.address) });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`log transaction ${hash} reverted`);
  return { hash, receipt };
}

/** Register a rule per asset that has none yet. Called on every tick; does nothing once registered. */
export function ensureRegistered(triggerId: string, config: StrategyConfig, account: Account | null, readings: Map<AssetSymbol, Reading>): void {
  const contract = chainLogAddress();
  if (!contract || !account) return;
  for (const asset of config.assets) {
    const reading = readings.get(asset);
    if (!reading || activeStrategyId(triggerId, asset) !== null || pendingRegistration.has(`${triggerId}:${asset}`)) continue;
    pendingRegistration.add(`${triggerId}:${asset}`);
    const data = registerCalldata(asset, config, reading);
    void enqueue(account, async () => {
      try {
        const { hash, receipt } = await send(account, contract, data);
        const log = receipt.logs.map((l) => { try { return decodeEventLog({ abi: STRATEGY_LOG_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "StrategyRegistered");
        if (log && log.eventName === "StrategyRegistered") addLog({ triggerId, asset, kind: "register", strategyId: log.args.id, txHash: hash });
      } finally {
        pendingRegistration.delete(`${triggerId}:${asset}`);
      }
    });
  }
}
const pendingRegistration = new Set<string>();

/** Record a filled live order against its asset's registered rule. */
export function recordFill(triggerId: string, account: Account | null, fill: { tradeId: number; asset: AssetSymbol; side: "buy" | "sell"; usdt: number; qty: number; txHash: string | null; paper: boolean; takeProfit: boolean }): void {
  const contract = chainLogAddress();
  if (!contract || !account || fill.paper || !fill.txHash) return;
  const txHash = fill.txHash;
  void enqueue(account, async () => {
    // The rule may still be registering (first tick); wait for it briefly rather than dropping the record.
    let id = activeStrategyId(triggerId, fill.asset);
    for (let i = 0; id === null && i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      id = activeStrategyId(triggerId, fill.asset);
    }
    if (id === null) return;
    const { hash } = await send(account, contract, recordCalldata(id, { ...fill, decimals: ASSETS[fill.asset].decimals, txHash }));
    addLog({ triggerId, asset: fill.asset, kind: "record", strategyId: id, tradeId: fill.tradeId, txHash: hash });
  });
}

/** Mark every registered rule of this agent as stopped (agent paused or deleted). */
export function stopRegistered(triggerId: string, assets: readonly AssetSymbol[], account: Account | null): void {
  const contract = chainLogAddress();
  if (!contract || !account) return;
  for (const asset of assets) {
    const id = activeStrategyId(triggerId, asset);
    if (id === null) continue;
    void enqueue(account, async () => {
      const { hash } = await send(account, contract, stopCalldata(id));
      addLog({ triggerId, asset, kind: "stop", strategyId: id, txHash: hash });
    });
  }
}
