/**
 * Route statistics in sqlite: for every provider on every route (action, from
 * chain, to chain), how often it ran, how often it succeeded, how long it took
 * and whether it has been failing lately. Aggregated, so it holds no addresses,
 * accounts or amounts, and every user's runs improve the same record.
 */
import { getDb } from "../accounts/store.js";
import type { ExecutionOutcome, RouteStat } from "./types.js";

let initialized = false;
function ensureSchema(): void {
  if (initialized) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS route_stats (
      provider TEXT NOT NULL,
      action TEXT NOT NULL,
      chain_from TEXT NOT NULL,
      chain_to TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      total_ms INTEGER NOT NULL DEFAULT 0,
      last_failure_at INTEGER,
      last_error TEXT,
      PRIMARY KEY (provider, action, chain_from, chain_to)
    );
  `);
  initialized = true;
}

interface Row {
  provider: string; action: string; chain_from: string; chain_to: string; attempts: number; successes: number;
  consecutive_failures: number; total_ms: number; last_failure_at: number | null; last_error: string | null;
}

const toStat = (r: Row): RouteStat => ({
  provider: r.provider, action: r.action, chainFrom: r.chain_from, chainTo: r.chain_to, attempts: r.attempts,
  successes: r.successes, consecutiveFailures: r.consecutive_failures, averageMs: r.successes ? Math.round(r.total_ms / r.successes) : 0,
  lastFailureAt: r.last_failure_at, lastError: r.last_error,
});

export function recordRouteOutcome(o: ExecutionOutcome): void {
  ensureSchema();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO route_stats (provider, action, chain_from, chain_to, attempts, successes, consecutive_failures, total_ms, last_failure_at, last_error)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, action, chain_from, chain_to) DO UPDATE SET
         attempts = attempts + 1,
         successes = successes + excluded.successes,
         consecutive_failures = CASE WHEN excluded.successes = 1 THEN 0 ELSE consecutive_failures + 1 END,
         total_ms = total_ms + excluded.total_ms,
         last_failure_at = CASE WHEN excluded.successes = 1 THEN last_failure_at ELSE excluded.last_failure_at END,
         last_error = CASE WHEN excluded.successes = 1 THEN last_error ELSE excluded.last_error END`
    )
    .run(o.provider, o.action, o.chainFrom, o.chainTo, o.success ? 1 : 0, o.success ? 0 : 1, o.success ? o.durationMs : 0, o.success ? null : now, o.success ? null : (o.error ?? "").slice(0, 300));
}

export function getRouteStat(provider: string, action: string, chainFrom: string, chainTo: string): RouteStat | null {
  ensureSchema();
  const row = getDb().prepare(`SELECT * FROM route_stats WHERE provider = ? AND action = ? AND chain_from = ? AND chain_to = ?`).get(provider, action, chainFrom, chainTo) as Row | undefined;
  return row ? toStat(row) : null;
}

export function topRouteStats(limit: number): RouteStat[] {
  ensureSchema();
  const rows = getDb().prepare(`SELECT * FROM route_stats WHERE attempts >= 2 ORDER BY attempts DESC LIMIT ?`).all(limit) as Row[];
  return rows.map(toStat);
}
