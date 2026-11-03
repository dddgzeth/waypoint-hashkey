/**
 * Every order the agent fills, and the positions and profit that follow from them. Cost basis is the
 * average cost of the open quantity; realized profit is booked on each sale; unrealized uses the live pool price.
 */
import { getDb } from "../accounts/store.js";
import type { AssetSymbol } from "./strategy.js";

let ready = false;
function ensureSchema(): void {
  if (ready) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS hsk_trades (
      trade_id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      asset TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      usdt REAL NOT NULL,
      price REAL NOT NULL,
      signal TEXT NOT NULL,
      reason TEXT NOT NULL,
      tx_hash TEXT,
      paper INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hsk_trades_trigger ON hsk_trades(trigger_id, ts);
    CREATE TABLE IF NOT EXISTS hsk_decisions (
      decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      asset TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hsk_decisions_trigger ON hsk_decisions(trigger_id, ts);
  `);
  // Paper and live are separate books. Decisions written before this column existed were all paper except the
  // short live test of 2026-11-03, which is recognised by its live trades' time window.
  const cols = getDb().prepare(`PRAGMA table_info(hsk_decisions)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "paper")) {
    getDb().exec(`ALTER TABLE hsk_decisions ADD COLUMN paper INTEGER NOT NULL DEFAULT 1`);
    const live = getDb().prepare(`SELECT trigger_id, MIN(ts) AS a, MAX(ts) AS b FROM hsk_trades WHERE paper = 0 GROUP BY trigger_id`).all() as Array<{ trigger_id: string; a: number; b: number }>;
    for (const w of live) getDb().prepare(`UPDATE hsk_decisions SET paper = 0 WHERE trigger_id = ? AND ts BETWEEN ? AND ?`).run(w.trigger_id, w.a - 180, w.b + 120);
  }
  ready = true;
}

export interface Trade {
  tradeId: number;
  triggerId: string;
  ts: number;
  asset: AssetSymbol;
  side: "buy" | "sell";
  qty: number;
  usdt: number;
  price: number;
  signal: string;
  reason: string;
  txHash: string | null;
  paper: boolean;
}

export function recordTrade(t: Omit<Trade, "tradeId" | "ts">): number {
  ensureSchema();
  const info = getDb()
    .prepare(`INSERT INTO hsk_trades (trigger_id, ts, asset, side, qty, usdt, price, signal, reason, tx_hash, paper) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(t.triggerId, Math.floor(Date.now() / 1000), t.asset, t.side, t.qty, t.usdt, t.price, t.signal, t.reason, t.txHash, t.paper ? 1 : 0);
  return Number(info.lastInsertRowid);
}

export type Mode = "paper" | "live";
const flag = (mode: Mode): number => (mode === "paper" ? 1 : 0);

export function listTrades(triggerId: string, mode: Mode, limit = 50): Trade[] {
  ensureSchema();
  const rows = getDb().prepare(`SELECT * FROM hsk_trades WHERE trigger_id = ? AND paper = ? ORDER BY ts DESC, trade_id DESC LIMIT ?`).all(triggerId, flag(mode), limit) as Array<Record<string, unknown>>;
  return rows.map(toTrade);
}

function toTrade(r: Record<string, unknown>): Trade {
  return {
    tradeId: r.trade_id as number,
    triggerId: r.trigger_id as string,
    ts: r.ts as number,
    asset: r.asset as AssetSymbol,
    side: r.side as "buy" | "sell",
    qty: r.qty as number,
    usdt: r.usdt as number,
    price: r.price as number,
    signal: r.signal as string,
    reason: r.reason as string,
    txHash: (r.tx_hash as string | null) ?? null,
    paper: r.paper === 1,
  };
}

export function recordDecision(triggerId: string, mode: Mode, asset: string, action: string, detail: string): void {
  ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  // The same refusal repeats every minute (cooldown, position cap, ...): keep one line per hour, not sixty.
  if (action === "blocked" || action === "error") {
    const last = getDb()
      .prepare(`SELECT ts, action, detail FROM hsk_decisions WHERE trigger_id = ? AND paper = ? AND asset = ? ORDER BY ts DESC, rowid DESC LIMIT 1`)
      .get(triggerId, flag(mode), asset) as { ts: number; action: string; detail: string } | undefined;
    if (last && last.action === action && last.detail.slice(0, 45) === detail.slice(0, 45) && now - last.ts < 3600) return;
  }
  getDb().prepare(`INSERT INTO hsk_decisions (trigger_id, ts, asset, action, detail, paper) VALUES (?, ?, ?, ?, ?, ?)`).run(triggerId, now, asset, action, detail, flag(mode));
}

export function listDecisions(triggerId: string, mode: Mode, limit = 30): Array<{ ts: number; asset: string; action: string; detail: string }> {
  ensureSchema();
  return getDb().prepare(`SELECT ts, asset, action, detail FROM hsk_decisions WHERE trigger_id = ? AND paper = ? ORDER BY decision_id DESC LIMIT ?`).all(triggerId, flag(mode), limit) as Array<{ ts: number; asset: string; action: string; detail: string }>;
}

export interface Position {
  asset: AssetSymbol;
  qty: number;
  avgCost: number;
  costUsd: number;
  realizedUsd: number;
}

/** Replays the ledger oldest-first into one position per asset. */
export function positions(triggerId: string, mode: Mode): Position[] {
  ensureSchema();
  const rows = (getDb().prepare(`SELECT * FROM hsk_trades WHERE trigger_id = ? AND paper = ? ORDER BY ts, trade_id`).all(triggerId, flag(mode)) as Array<Record<string, unknown>>).map(toTrade);
  const book = new Map<AssetSymbol, Position>();
  for (const t of rows) {
    const p = book.get(t.asset) ?? { asset: t.asset, qty: 0, avgCost: 0, costUsd: 0, realizedUsd: 0 };
    if (t.side === "buy") {
      p.costUsd += t.usdt;
      p.qty += t.qty;
      p.avgCost = p.qty > 0 ? p.costUsd / p.qty : 0;
    } else {
      const sold = Math.min(t.qty, p.qty);
      p.realizedUsd += t.usdt - sold * p.avgCost;
      p.qty -= sold;
      p.costUsd = p.qty * p.avgCost;
      // A live sale is rounded down to 6 decimals, so a closed position can leave a sliver; treat it as flat.
      if (p.qty < 1e-4) {
        p.qty = 0;
        p.costUsd = 0;
        p.avgCost = 0;
      }
    }
    book.set(t.asset, p);
  }
  return [...book.values()];
}

export interface PnlReport {
  positions: Array<Position & { price: number; valueUsd: number; unrealizedUsd: number; unrealizedPct: number }>;
  realizedUsd: number;
  unrealizedUsd: number;
  totalUsd: number;
  /** Realized profit booked since 00:00 UTC plus the open positions' change since they were opened; used by the daily loss limit. */
  todayRealizedUsd: number;
  tradeCount: number;
}

export function pnl(triggerId: string, prices: Partial<Record<AssetSymbol, number>>, mode: Mode): PnlReport {
  const book = positions(triggerId, mode);
  const rows = book.map((p) => {
    const price = prices[p.asset] ?? p.avgCost;
    const valueUsd = p.qty * price;
    const unrealizedUsd = p.qty > 0 ? valueUsd - p.costUsd : 0;
    return { ...p, price, valueUsd, unrealizedUsd, unrealizedPct: p.costUsd > 0 ? (unrealizedUsd / p.costUsd) * 100 : 0 };
  });
  const startOfDay = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
  const all = listTrades(triggerId, mode, 5000);
  // Today's realized result: replay only the trades up to the day's start for the baseline, then take the difference.
  const realizedTotal = rows.reduce((s, p) => s + p.realizedUsd, 0);
  const before = replayRealized(all.filter((t) => t.ts < startOfDay));
  return {
    positions: rows,
    realizedUsd: realizedTotal,
    unrealizedUsd: rows.reduce((s, p) => s + p.unrealizedUsd, 0),
    totalUsd: realizedTotal + rows.reduce((s, p) => s + p.unrealizedUsd, 0),
    todayRealizedUsd: realizedTotal - before,
    tradeCount: all.length,
  };
}

function replayRealized(trades: Trade[]): number {
  const ordered = [...trades].sort((a, b) => a.ts - b.ts || a.tradeId - b.tradeId);
  const qty = new Map<string, { q: number; cost: number }>();
  let realized = 0;
  for (const t of ordered) {
    const p = qty.get(t.asset) ?? { q: 0, cost: 0 };
    if (t.side === "buy") {
      p.q += t.qty;
      p.cost += t.usdt;
    } else {
      const avg = p.q > 0 ? p.cost / p.q : 0;
      const sold = Math.min(t.qty, p.q);
      realized += t.usdt - sold * avg;
      p.q -= sold;
      p.cost = p.q * avg;
    }
    qty.set(t.asset, p);
  }
  return realized;
}

/** When the current open position in `asset` was opened: the first buy after the quantity was last zero. */
export function openedAt(triggerId: string, asset: AssetSymbol, mode: Mode): number | null {
  ensureSchema();
  const rows = (getDb().prepare(`SELECT * FROM hsk_trades WHERE trigger_id = ? AND paper = ? AND asset = ? ORDER BY ts, trade_id`).all(triggerId, flag(mode), asset) as Array<Record<string, unknown>>).map(toTrade);
  let qty = 0;
  let opened: number | null = null;
  for (const t of rows) {
    if (t.side === "buy") {
      if (qty <= 1e-12) opened = t.ts;
      qty += t.qty;
    } else {
      qty = Math.max(0, qty - t.qty);
      if (qty <= 1e-12) opened = null;
    }
  }
  return opened;
}

export function lastTradeTs(triggerId: string, asset: AssetSymbol, mode: Mode): number | null {
  ensureSchema();
  const row = getDb().prepare(`SELECT MAX(ts) AS ts FROM hsk_trades WHERE trigger_id = ? AND paper = ? AND asset = ?`).get(triggerId, flag(mode), asset) as { ts: number | null };
  return row.ts;
}
