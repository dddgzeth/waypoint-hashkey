/**
 * The trading agent's loop body. One tick, per asset: read the market, compare it with the last day and the
 * open position, find signals, let the model confirm entries, apply the hard risk limits, trade, and write
 * down what was done and why.
 */
import { createPublicClient, erc20Abi, http, parseUnits } from "viem";
import type { Account } from "viem";
import { hashkey } from "../chains/hashkey.js";
import { quoteOut } from "../providers/hashkeyswap.js";
import { ensureRegistered, listChainLog, recordFill, type ChainLogEntry } from "./chainlog.js";
import { decideEntry } from "./decision.js";
import { swapOnHashkey } from "./exec.js";
import { lastTradeTs, listDecisions, listTrades, openedAt, pnl, positions, recordDecision, recordTrade, type Mode, type PnlReport } from "./ledger.js";
import { ASSETS, history, readMarket, recentFlow, storeReading, USDT, USDT_DECIMALS, type Reading } from "./market.js";
import { checkBuy, dayLossUsd } from "./risk.js";
import { findSignals, priceStats, type Signal } from "./signals.js";
import { sizeFactor, type AssetSymbol, type StrategyConfig } from "./strategy.js";

const client = createPublicClient({ chain: hashkey.viemChain, transport: http(hashkey.publicRpc) });

async function balanceOf(token: `0x${string}`, owner: `0x${string}`, decimals: number): Promise<number> {
  const raw = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  return Number(raw) / 10 ** decimals;
}

/** HSK kept in a live wallet to pay gas: below it the agent neither buys nor sells (a sell without gas would strand the position). */
const GAS_RESERVE_HSK = Number(process.env.HASHKEY_GAS_RESERVE_HSK ?? 1);

async function gasShortfall(owner: `0x${string}`): Promise<string | null> {
  const hsk = Number(await client.getBalance({ address: owner })) / 1e18;
  return hsk < GAS_RESERVE_HSK ? `The wallet has ${hsk.toFixed(3)} HSK for gas, below the ${GAS_RESERVE_HSK} HSK reserve. Top it up with HSK to continue.` : null;
}

export interface TickResult {
  /** One line per order filled this tick; empty when nothing was traded. */
  fills: Array<{ tradeId: number; asset: AssetSymbol; side: "buy" | "sell"; usdt: number; qty: number; txHash: string | null; paper: boolean; reason: string }>;
  errors: string[];
}

/** Slippage of a buy of `usd`, in percent, against the pool's marginal price (the fee is excluded). */
async function impactFor(asset: AssetSymbol, usd: number, spot: number): Promise<number> {
  const a = ASSETS[asset];
  const out = await quoteOut(USDT, a.address, parseUnits(usd.toFixed(USDT_DECIMALS), USDT_DECIMALS));
  const qty = Number(out.amountOut) / 10 ** a.decimals;
  // The pool fee is counted separately in the round-trip cost; keep only the slippage here.
  return qty > 0 ? Math.max(0, (usd / qty / spot - 1) * 100 - 0.3) : 100;
}

export async function tickAgent(triggerId: string, config: StrategyConfig, account: Account | null, owner: `0x${string}`): Promise<TickResult> {
  const result: TickResult = { fills: [], errors: [] };
  const readings = new Map<AssetSymbol, Reading>();
  for (const asset of config.assets) {
    try {
      const r = await readMarket(asset);
      storeReading(r);
      readings.set(asset, r);
    } catch (err) {
      result.errors.push(`${asset}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const prices = Object.fromEntries([...readings.entries()].map(([a, r]) => [a, r.poolPrice])) as Partial<Record<AssetSymbol, number>>;
  const live = config.mode === "live";
  if (live && !account) {
    result.errors.push("Live mode needs an execution wallet that can sign.");
    return result;
  }

  ensureRegistered(triggerId, config, account, readings);
  const noGas = live ? await gasShortfall(owner).catch(() => null) : null;

  for (const asset of config.assets) {
    const reading = readings.get(asset);
    if (!reading) continue;
    const a = ASSETS[asset];
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const report = pnl(triggerId, prices, config.mode);
      const position = positions(triggerId, config.mode).find((p) => p.asset === asset);
      const stats = priceStats(history(asset, 24).map((p) => p.poolPrice), reading.poolPrice);
      const probeUsd = config.maxTradeUsd * sizeFactor(config.riskAppetite);
      const impactPct = await impactFor(asset, Math.min(probeUsd, Math.max(5, reading.depthUsd * 0.02)), reading.poolPrice);
      const signals = findSignals({ reading, stats, position, openedAt: openedAt(triggerId, asset, config.mode), config, impactPct, nowSec });

      // Exits first: they only reduce risk.
      const exit = signals.filter((s) => s.side === "sell").sort((x, y) => Number(y.forced) - Number(x.forced))[0];
      if (exit && position && position.qty > 0) {
        if (noGas) {
          recordDecision(triggerId, config.mode, asset, "blocked", `${exit.kind}: ${noGas}`);
          continue;
        }
        await closePosition({ triggerId, config, account, owner, asset, position: position.qty, reading, signal: exit, result });
        continue;
      }

      const entry = signals.filter((s) => s.side === "buy").sort((x, y) => y.edgePct - x.edgePct)[0];
      if (!entry) continue;
      if (noGas) {
        recordDecision(triggerId, config.mode, asset, "blocked", `${entry.kind}: ${noGas}`);
        continue;
      }

      const walletUsdt = live ? await balanceOf(USDT, owner, USDT_DECIMALS) : null;
      const verdict = checkBuy({ config, position, report, depthUsd: reading.depthUsd, lastTradeSec: lastTradeTs(triggerId, asset, config.mode), nowSec, walletUsdt });
      if (!verdict.ok) {
        recordDecision(triggerId, config.mode, asset, "blocked", `${entry.kind}: ${verdict.reasons.join(" ")}`);
        continue;
      }
      const flow = await recentFlow(asset).catch(() => ({ netUsdt: 0, swaps: 0 }));
      const decision = await decideEntry({ config, reading, stats, signal: entry, flow, impactPct, allowedUsd: verdict.usd });
      if (decision.decision === "skip") {
        recordDecision(triggerId, config.mode, asset, "skipped", `${entry.kind} (${decision.source}): ${decision.rationale}`);
        continue;
      }
      const usd = Math.floor(verdict.usd * Math.max(0.25, decision.sizeFraction) * 100) / 100;
      if (usd < 5) {
        recordDecision(triggerId, config.mode, asset, "skipped", `${entry.kind}: order of ${usd} USDT is below the 5 USDT minimum`);
        continue;
      }
      await openPosition({ triggerId, config, account, owner, asset, usd, reading, signal: entry, rationale: decision.rationale, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordDecision(triggerId, config.mode, asset, "error", message.slice(0, 300));
      result.errors.push(`${asset}: ${message}`);
    }
    void a;
  }
  return result;
}

async function openPosition(args: { triggerId: string; config: StrategyConfig; account: Account | null; owner: `0x${string}`; asset: AssetSymbol; usd: number; reading: Reading; signal: Signal; rationale: string; result: TickResult }): Promise<void> {
  const { triggerId, config, account, owner, asset, usd, reading, signal, rationale, result } = args;
  const a = ASSETS[asset];
  let qty: number;
  let spent = usd;
  let txHash: string | null = null;
  if (config.mode === "live" && account) {
    const r = await swapOnHashkey(account, USDT, a.address, usd, `Agent buy: ${usd} USDT of ${asset} (${signal.kind})`);
    qty = r.actualAmountOut;
    spent = r.resolvedAmountIn;
    txHash = r.txHash;
  } else {
    const out = await quoteOut(USDT, a.address, parseUnits(usd.toFixed(USDT_DECIMALS), USDT_DECIMALS));
    qty = Number(out.amountOut) / 10 ** a.decimals;
  }
  const price = spent / qty;
  const tradeId = recordTrade({ triggerId, asset, side: "buy", qty, usdt: spent, price, signal: signal.kind, reason: rationale, txHash, paper: config.mode === "paper" });
  recordDecision(triggerId, config.mode, asset, "bought", `${spent.toFixed(2)} USDT -> ${qty.toFixed(6)} ${asset} at ${price.toFixed(6)} (${signal.kind}). ${rationale}`);
  result.fills.push({ tradeId, asset, side: "buy", usdt: spent, qty, txHash, paper: config.mode === "paper", reason: rationale });
  recordFill(triggerId, account, { tradeId, asset, side: "buy", usdt: spent, qty, txHash, paper: config.mode === "paper", takeProfit: false });
  void reading;
}

async function closePosition(args: { triggerId: string; config: StrategyConfig; account: Account | null; owner: `0x${string}`; asset: AssetSymbol; position: number; reading: Reading; signal: Signal; result: TickResult }): Promise<void> {
  const { triggerId, config, account, owner, asset, signal, result } = args;
  const a = ASSETS[asset];
  let qty = args.position;
  let received: number;
  let txHash: string | null = null;
  if (config.mode === "live" && account) {
    const held = await balanceOf(a.address, owner, a.decimals);
    qty = Math.floor(Math.min(qty, held) * 1e6) / 1e6;
    if (qty <= 0) {
      recordDecision(triggerId, config.mode, asset, "blocked", `${signal.kind}: the wallet no longer holds ${asset} (WHSK/WETH) to sell`);
      return;
    }
    const r = await swapOnHashkey(account, a.address, USDT, qty, `Agent sell: ${qty} ${asset} (${signal.kind})`);
    qty = r.resolvedAmountIn;
    received = r.actualAmountOut;
    txHash = r.txHash;
  } else {
    const out = await quoteOut(a.address, USDT, parseUnits(qty.toFixed(Math.min(a.decimals, 8)), a.decimals));
    received = Number(out.amountOut) / 10 ** USDT_DECIMALS;
  }
  const price = received / qty;
  const tradeId = recordTrade({ triggerId, asset, side: "sell", qty, usdt: received, price, signal: signal.kind, reason: signal.detail, txHash, paper: config.mode === "paper" });
  recordDecision(triggerId, config.mode, asset, "sold", `${qty.toFixed(6)} ${asset} -> ${received.toFixed(2)} USDT at ${price.toFixed(6)} (${signal.kind}). ${signal.detail}`);
  result.fills.push({ tradeId, asset, side: "sell", usdt: received, qty, txHash, paper: config.mode === "paper", reason: signal.detail });
  recordFill(triggerId, account, { tradeId, asset, side: "sell", usdt: received, qty, txHash, paper: config.mode === "paper", takeProfit: signal.kind !== "exit_stop" && signal.kind !== "exit_timeout" });
}

export interface AgentStatus {
  /** Which book this is: the paper ledger or the live ledger. They never mix. */
  view: Mode;
  /** One line about the other book, so the panel can point to it. */
  otherBook: { mode: Mode; trades: number; realizedUsd: number };
  readings: Reading[];
  report: PnlReport;
  trades: ReturnType<typeof listTrades>;
  decisions: ReturnType<typeof listDecisions>;
  /** Loss counted against today's limit (realized today plus open losses), in USDT. */
  todayLossUsd: number;
  /** On-chain log writes (rule registrations and recorded fills); empty when no contract is configured. */
  chainLog: ChainLogEntry[];
}

/** The agent's state for one book. `view` picks paper or live; it defaults to the mode the agent is running in. */
export async function agentStatus(triggerId: string, config: StrategyConfig, view: Mode = config.mode): Promise<AgentStatus> {
  const rs = (await Promise.all(config.assets.map((asset) => readMarket(asset).catch(() => null)))).filter((r): r is Reading => r !== null);
  const prices = Object.fromEntries(rs.map((r) => [r.asset, r.poolPrice])) as Partial<Record<AssetSymbol, number>>;
  const report = pnl(triggerId, prices, view);
  const other: Mode = view === "paper" ? "live" : "paper";
  const otherReport = pnl(triggerId, prices, other);
  return {
    view,
    readings: rs,
    report,
    todayLossUsd: dayLossUsd(report),
    trades: listTrades(triggerId, view, 30),
    decisions: listDecisions(triggerId, view, 30),
    chainLog: view === "live" ? listChainLog(triggerId, 50) : [],
    otherBook: { mode: other, trades: otherReport.tradeCount, realizedUsd: otherReport.realizedUsd },
  };
}
