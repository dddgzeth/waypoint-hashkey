/**
 * The memory backend registry. MEMORY_BACKEND picks one (default: sqlite).
 * To add a backend, implement MemoryStore (./types.ts) and list it here.
 */
import type { MemoryStore } from "./types.js";
import { sqliteMemory } from "./sqliteMemory.js";
import { createInMemoryMemory } from "./inMemory.js";

export type { MemoryStore, ExecutionOutcome, RouteStat } from "./types.js";

const BACKENDS: Record<string, () => MemoryStore> = {
  sqlite: () => sqliteMemory,
  memory: createInMemoryMemory,
};

let active: MemoryStore | null = null;

export function getMemory(): MemoryStore {
  if (active) return active;
  const name = (process.env.MEMORY_BACKEND ?? "sqlite").trim().toLowerCase();
  const make = BACKENDS[name];
  if (!make) throw new Error(`Unknown MEMORY_BACKEND "${name}". Available: ${Object.keys(BACKENDS).join(", ")}`);
  active = make();
  return active;
}

/** For tests: replace or reset the active backend. */
export function setMemory(store: MemoryStore | null): void {
  active = store;
}
