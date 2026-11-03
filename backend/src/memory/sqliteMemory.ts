import { buildMemoryContext } from "./recall.js";
import { extractFromTurn } from "./extraction.js";
import { buildKnowledgeContext } from "../knowledge/store.js";
import { getRouteStat, recordRouteOutcome, topRouteStats } from "./routeStats.js";
import { routeHistoryNote } from "./routeHistory.js";
import type { MemoryStore } from "./types.js";

/** The default backend: layered user memory and execution knowledge in sqlite, with route statistics. */
export const sqliteMemory: MemoryStore = {
  id: "sqlite",
  layers: ["conversation", "atoms", "scenarios", "persona", "knowledge", "route-outcomes"],
  recall: (accountId, query) => buildMemoryContext(accountId, query),
  record: async (accountId, turn, model) => {
    await extractFromTurn(accountId, turn.userText, turn.assistantText, model);
  },
  knowledge: (query, limit = 3) => [buildKnowledgeContext(query, limit), routeHistoryNote(topRouteStats(6))].filter(Boolean).join("\n\n"),
  recordOutcome: recordRouteOutcome,
  routeStat: getRouteStat,
  topRoutes: topRouteStats,
};
