import type { ExecutionOutcome, MemoryStore, RouteStat } from "./types.js";
import { routeHistoryNote } from "./routeHistory.js";

/**
 * A second, deliberately small backend that keeps everything in process memory:
 * raw user statements instead of extracted atoms, no persistence. It exists to
 * prove the memory layer is swappable (MEMORY_BACKEND=memory) and for tests.
 */
const MAX_STATEMENTS = 50;

export function createInMemoryMemory(): MemoryStore {
  const statements = new Map<string, string[]>();
  const stats = new Map<string, RouteStat & { totalMs: number }>();
  const keyOf = (p: string, a: string, f: string, t: string) => `${p}|${a}|${f}|${t}`;
  const visible = (s: RouteStat & { totalMs: number }): RouteStat => ({ ...s, averageMs: s.successes ? Math.round(s.totalMs / s.successes) : 0 });

  return {
    id: "memory",
    layers: ["statements", "route-outcomes"],
    recall(accountId, query) {
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const mine = statements.get(accountId) ?? [];
      const hits = mine.filter((s) => words.some((w) => s.toLowerCase().includes(w))).slice(-6);
      return hits.length ? `<user-memory>\n${hits.map((h) => `[statement] ${h}`).join("\n")}\n</user-memory>` : "";
    },
    async record(accountId, turn) {
      const list = statements.get(accountId) ?? [];
      list.push(turn.userText);
      statements.set(accountId, list.slice(-MAX_STATEMENTS));
    },
    knowledge: (_query, _limit) => routeHistoryNote([...stats.values()].filter((s) => s.attempts >= 2).sort((a, b) => b.attempts - a.attempts).slice(0, 6).map(visible)),
    recordOutcome(o: ExecutionOutcome) {
      const key = keyOf(o.provider, o.action, o.chainFrom, o.chainTo);
      const cur = stats.get(key) ?? { provider: o.provider, action: o.action, chainFrom: o.chainFrom, chainTo: o.chainTo, attempts: 0, successes: 0, consecutiveFailures: 0, averageMs: 0, lastFailureAt: null, lastError: null, totalMs: 0 };
      cur.attempts += 1;
      if (o.success) { cur.successes += 1; cur.consecutiveFailures = 0; cur.totalMs += o.durationMs; }
      else { cur.consecutiveFailures += 1; cur.lastFailureAt = Date.now(); cur.lastError = (o.error ?? "").slice(0, 300); }
      stats.set(key, cur);
    },
    routeStat: (p, a, f, t) => { const s = stats.get(keyOf(p, a, f, t)); return s ? visible(s) : null; },
    topRoutes: (limit) => [...stats.values()].sort((a, b) => b.attempts - a.attempts).slice(0, limit).map(visible),
  };
}
