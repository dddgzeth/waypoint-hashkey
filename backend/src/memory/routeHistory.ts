import type { RouteStat } from "./types.js";

/** The planner's note about how routes have actually performed, or "" when there is no history yet. */
export function routeHistoryNote(stats: RouteStat[]): string {
  if (!stats.length) return "";
  const lines = stats.map((s) => {
    const route = s.chainFrom === s.chainTo ? s.chainFrom : `${s.chainFrom} to ${s.chainTo}`;
    const speed = s.successes ? `, about ${Math.max(1, Math.round(s.averageMs / 1000))}s per run` : "";
    const trouble = s.consecutiveFailures >= 2 ? `, the last ${s.consecutiveFailures} runs failed` : "";
    return `- ${s.action} via ${s.provider} on ${route}: ${s.successes} of ${s.attempts} runs succeeded${speed}${trouble}`;
  });
  return `<route-history>\nHow routes have performed in real executions (for judgement only; the router picks the provider):\n${lines.join("\n")}\n</route-history>`;
}
