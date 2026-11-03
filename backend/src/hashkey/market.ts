/**
 * Market data for the trading agent: what HashKey Swap's pools say, what the rest of the market says,
 * and how deep the pool is. A sampler stores every reading so the agent can compare now with the last day.
 */
import { createPublicClient, erc20Abi, http, parseAbi } from "viem";
import { getDb } from "../accounts/store.js";
import { hashkey } from "../chains/hashkey.js";
import type { AssetSymbol } from "./strategy.js";

export const USDT = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as const;
export const USDT_DECIMALS = 6;

export interface AssetInfo {
  symbol: AssetSymbol;
  /** The pool-side token (WHSK for the native HSK). */
  address: `0x${string}`;
  decimals: number;
  native: boolean;
  /** The WHSK/USDT or WETH/USDT pool on HashKey Swap, the venue the agent trades. */
  pool: `0x${string}`;
  cmcId: number;
  okxPair?: string;
}

export const ASSETS: Record<AssetSymbol, AssetInfo> = {
  HSK: { symbol: "HSK", address: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", decimals: 18, native: true, pool: "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC", cmcId: 33849 },
  ETH: { symbol: "ETH", address: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0", decimals: 18, native: false, pool: "0xb92b79ed6b370D5cFee2E14B1D0983C258304C16", cmcId: 1027, okxPair: "ETH-USDT" },
};

const client = createPublicClient({ chain: hashkey.viemChain, transport: http(hashkey.publicRpc) });

let schemaReady = false;
function ensureSchema(): void {
  if (schemaReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS hsk_prices (
      ts INTEGER NOT NULL,
      asset TEXT NOT NULL,
      pool_price REAL NOT NULL,
      ref_price REAL,
      PRIMARY KEY (asset, ts)
    );
  `);
  schemaReady = true;
}

const slot0Abi = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"]);

/** The pool's marginal price in USDT per asset, from its own price state. A quote for a whole unit would
 * fold the price impact of that unit into the number, which misreads a thin pool as being far from the market. */
export async function poolPrice(asset: AssetSymbol, blockNumber?: bigint): Promise<number> {
  const a = ASSETS[asset];
  const [sqrtPriceX96] = await client.readContract({ address: a.pool, abi: slot0Abi, functionName: "slot0", blockNumber });
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1 per token0, in raw units
  const assetIsToken0 = BigInt(a.address) < BigInt(USDT);
  return assetIsToken0 ? ratio * 10 ** (a.decimals - USDT_DECIMALS) : (1 / ratio) * 10 ** (a.decimals - USDT_DECIMALS);
}

/** USDT held by the pool: how much the pool can absorb. */
export async function poolDepthUsd(asset: AssetSymbol): Promise<number> {
  const raw = await client.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [ASSETS[asset].pool] });
  return Number(raw) / 10 ** USDT_DECIMALS;
}

const refCache = new Map<AssetSymbol, { price: number; at: number }>();
const REF_TTL_MS = 45_000;

/** The market's price for the asset, from CoinMarketCap (aggregated across venues). OKX is the cross-check for ETH. */
export async function referencePrice(asset: AssetSymbol): Promise<number> {
  const hit = refCache.get(asset);
  if (hit && Date.now() - hit.at < REF_TTL_MS) return hit.price;
  const a = ASSETS[asset];
  let price: number | null = null;
  const key = process.env.CMC_API_KEY;
  if (key) {
    try {
      const res = await fetch(`https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=${a.cmcId}`, { headers: { "X-CMC_PRO_API_KEY": key } });
      const body = (await res.json()) as { data?: Record<string, { quote: { USD: { price: number } } }> };
      price = body.data?.[String(a.cmcId)]?.quote.USD.price ?? null;
    } catch {
      price = null;
    }
  }
  if (price === null && a.okxPair) {
    const res = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${a.okxPair}`);
    const body = (await res.json()) as { data?: Array<{ last: string }> };
    price = body.data?.[0] ? Number(body.data[0].last) : null;
  }
  if (price === null || !Number.isFinite(price) || price <= 0) throw new Error(`No reference price for ${asset}`);
  refCache.set(asset, { price, at: Date.now() });
  return price;
}

const swapEvent = parseAbi(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);

/** Net USDT that traders pushed into (+) or out of (-) the pool over the last hour, and the number of swaps. */
export async function recentFlow(asset: AssetSymbol): Promise<{ netUsdt: number; swaps: number }> {
  const a = ASSETS[asset];
  const head = await client.getBlockNumber();
  const logs = await client.getLogs({ address: a.pool, event: swapEvent[0], fromBlock: head - 1800n, toBlock: head });
  const usdtIsToken1 = BigInt(a.address) < BigInt(USDT);
  let net = 0;
  for (const log of logs) {
    const delta = usdtIsToken1 ? log.args.amount1! : log.args.amount0!;
    net += Number(delta) / 10 ** USDT_DECIMALS;
  }
  return { netUsdt: net, swaps: logs.length };
}

export interface Reading {
  asset: AssetSymbol;
  at: number;
  poolPrice: number;
  refPrice: number;
  /** Percent the pool trades above (+) or below (-) the reference. */
  deviationPct: number;
  depthUsd: number;
}

export async function readMarket(asset: AssetSymbol): Promise<Reading> {
  const [pp, rp, depth] = await Promise.all([poolPrice(asset), referencePrice(asset), poolDepthUsd(asset)]);
  return { asset, at: Date.now(), poolPrice: pp, refPrice: rp, deviationPct: (pp / rp - 1) * 100, depthUsd: depth };
}

export function storeReading(r: Reading): void {
  ensureSchema();
  getDb().prepare(`INSERT OR REPLACE INTO hsk_prices (ts, asset, pool_price, ref_price) VALUES (?, ?, ?, ?)`).run(Math.floor(r.at / 1000), r.asset, r.poolPrice, r.refPrice);
}

export function history(asset: AssetSymbol, hours: number): Array<{ ts: number; poolPrice: number }> {
  ensureSchema();
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return (getDb().prepare(`SELECT ts, pool_price AS poolPrice FROM hsk_prices WHERE asset = ? AND ts >= ? ORDER BY ts`).all(asset, since) as Array<{ ts: number; poolPrice: number }>);
}

/** Fills the price history from the chain's archive state so the agent has a day of context from its first tick. */
export async function backfill(asset: AssetSymbol, hours = 24, stepMinutes = 30): Promise<number> {
  ensureSchema();
  const a = ASSETS[asset];
  const head = await client.getBlockNumber();
  const existing = new Set(history(asset, hours).map((p) => Math.floor(p.ts / 60)));
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  for (let m = hours * 60; m >= stepMinutes; m -= stepMinutes) {
    const ts = now - m * 60;
    if (existing.has(Math.floor(ts / 60))) continue;
    const block = head - BigInt(Math.round((m * 60) / 2)); // 2-second blocks
    try {
      const price = await poolPrice(asset, block);
      getDb().prepare(`INSERT OR IGNORE INTO hsk_prices (ts, asset, pool_price, ref_price) VALUES (?, ?, ?, NULL)`).run(ts, asset, price);
      added++;
    } catch {
      /* a block the node cannot serve is simply skipped */
    }
  }
  return added;
}

let sampler: ReturnType<typeof setInterval> | null = null;

/** Samples every tracked asset on an interval and keeps a rolling day of readings. */
export function startSampler(intervalMs = 30_000): void {
  if (sampler) return;
  ensureSchema();
  const sampleOnce = async () => {
    for (const asset of Object.keys(ASSETS) as AssetSymbol[]) {
      try {
        storeReading(await readMarket(asset));
      } catch (err) {
        console.error(`[hashkey] sample ${asset} failed:`, err instanceof Error ? err.message : err);
      }
    }
    getDb().prepare(`DELETE FROM hsk_prices WHERE ts < ?`).run(Math.floor(Date.now() / 1000) - 3 * 86400);
  };
  void (async () => {
    for (const asset of Object.keys(ASSETS) as AssetSymbol[]) {
      try {
        const n = await backfill(asset);
        console.log(`[hashkey] backfilled ${n} ${asset} points`);
      } catch (err) {
        console.error(`[hashkey] backfill ${asset} failed:`, err instanceof Error ? err.message : err);
      }
    }
    await sampleOnce();
  })();
  sampler = setInterval(() => void sampleOnce(), intervalMs);
  console.log(`[hashkey] market sampler started (every ${intervalMs}ms)`);
}
