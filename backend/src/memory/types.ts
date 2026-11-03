/**
 * The memory layer, as the rest of the platform sees it. Everything the agent
 * stages use to remember (what the user prefers, what has gone wrong before,
 * how each route has behaved so far) goes through this interface, so the
 * backend can be replaced without touching a caller. Pick one with
 * MEMORY_BACKEND (sqlite, the default, or memory); add one by implementing
 * MemoryStore and listing it in ./index.ts.
 *
 * Conversation history (sessions and turns) is not memory in this sense: it is
 * stored by the session store and read directly.
 */

/** What happened when one step actually ran. Aggregated across users; never contains addresses or amounts. */
export interface ExecutionOutcome {
  /** The service that carried the step out: relay, lifi, enso, okx, aave, ... */
  provider: string;
  action: string;
  chainFrom: string;
  chainTo: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

/** The running record for one provider on one route. */
export interface RouteStat {
  provider: string;
  action: string;
  chainFrom: string;
  chainTo: string;
  attempts: number;
  successes: number;
  consecutiveFailures: number;
  averageMs: number;
  lastFailureAt: number | null;
  lastError: string | null;
}

export interface MemoryStore {
  id: string;
  /** What this backend keeps: conversation, atoms, scenarios, persona, knowledge, outcomes ... */
  layers: readonly string[];
  /** Context about this user for the planner, ready to splice into a prompt ("" when there is none). */
  recall(accountId: string, query: string): string;
  /** Learns from a finished turn. */
  record(accountId: string, turn: { userText: string; assistantText: string }, model: string): Promise<void>;
  /** Facts about how execution behaves (known pitfalls, how each route has performed), ready to splice into a prompt. */
  knowledge(query: string, limit?: number): string;
  /** Records the result of one executed step. */
  recordOutcome(outcome: ExecutionOutcome): void;
  /** How one provider has done on one route so far, or null when it has never run there. */
  routeStat(provider: string, action: string, chainFrom: string, chainTo: string): RouteStat | null;
  /** The most-used routes, for the planner's history note. */
  topRoutes(limit: number): RouteStat[];
}
