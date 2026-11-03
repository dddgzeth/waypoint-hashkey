/**
 * Chooses which provider carries a step and falls back down the list when one
 * fails. The order comes from each provider's declared priority, an explicit
 * pin in the plan, and the recorded health of every provider on the route: a
 * provider that has been failing here repeatedly goes to the back of the line.
 */
import type { PlanStep } from "../models.js";
import { getMemory } from "../memory/index.js";
import { isRouteFault } from "../memory/routeFault.js";
import { allProviders } from "./index.js";
import type { RouteProvider, RouteRequest } from "./types.js";

/** A provider that failed this many runs in a row on a route is tried last while the failures are recent. */
const DEMOTE_AFTER_FAILURES = () => Number(process.env.ROUTE_DEMOTE_AFTER_FAILURES ?? 3);
const DEMOTE_WINDOW_MS = () => Number(process.env.ROUTE_DEMOTE_WINDOW_MINUTES ?? 360) * 60_000;

/** A same-chain swap uses the swap providers; everything else (including a swap pinned to LI.FI) uses the bridge providers. */
export function routeKind(step: PlanStep): "swap" | "bridge" {
  const sameChain = step.chainFrom === step.chainTo;
  return step.action === "swap" && sameChain && step.vendorAdapter?.toLowerCase() !== "lifi" ? "swap" : "bridge";
}

export function isDemoted(provider: RouteProvider, step: PlanStep): boolean {
  const stat = getMemory().routeStat(provider.id, step.action, step.chainFrom, step.chainTo);
  return Boolean(
    stat && stat.consecutiveFailures >= DEMOTE_AFTER_FAILURES() && stat.lastFailureAt !== null && Date.now() - stat.lastFailureAt < DEMOTE_WINDOW_MS()
  );
}

/** The providers to try for a step, in order. */
export function providersFor(step: PlanStep): RouteProvider[] {
  const kind = routeKind(step);
  const pinned = step.vendorAdapter?.toLowerCase();
  const capable = allProviders().filter((p) => p.kind === kind && p.supports(step));
  // A bridge pinned in the plan is used alone, with no fallback.
  if (kind === "bridge" && pinned) {
    const only = capable.find((p) => p.id === pinned);
    if (only) return [only];
  }
  const ordered = [...capable].sort((a, b) => a.priority(step) - b.priority(step));
  return [...ordered.filter((p) => !isDemoted(p, step)), ...ordered.filter((p) => isDemoted(p, step))];
}

/** Builds the step with the first provider that can route it. A failed quote is recorded against that provider. */
export async function routeStep(req: RouteRequest) {
  const { step } = req;
  let lastError: unknown;
  for (const provider of providersFor(step)) {
    const started = Date.now();
    try {
      return { ...(await provider.build(req)), provider: provider.id };
    } catch (err) {
      lastError = err;
      if (!isRouteFault(err)) continue;
      getMemory().recordOutcome({
        provider: provider.id,
        action: step.action,
        chainFrom: step.chainFrom,
        chainTo: step.chainTo,
        success: false,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw lastError ?? new Error(`No provider can route ${step.action} from ${step.chainFrom} to ${step.chainTo}`);
}
