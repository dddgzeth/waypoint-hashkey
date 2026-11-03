/**
 * A route provider is one external service that can carry a swap or a bridge
 * (OKX DEX, Enso, Relay, LI.FI ...). The router (./router.ts) asks every
 * registered provider whether it can carry a step, orders the ones that can,
 * and falls back to the next when one fails, so adding a provider is one
 * module here plus one line in ./index.ts.
 */
import type { PlanStep } from "../models.js";
import type { BuiltStep } from "../execution/shared.js";

export interface RouteRequest {
  step: PlanStep;
  amountIn: number;
  fromAddress: `0x${string}`;
  recipientAddress: `0x${string}`;
  /** The output token's contract, or null for the chain's native token. */
  outputTokenAddress: `0x${string}` | null;
  outputDecimals: number;
}

export interface RouteProvider {
  id: string;
  /** swap: a trade on one chain. bridge: any movement across chains (or a same-chain route pinned to a bridge). */
  kind: "swap" | "bridge";
  /** Whether this provider can carry the step at all. */
  supports(step: PlanStep): boolean;
  /** Lower runs first among the providers that support the step and are not pinned. */
  priority(step: PlanStep): number;
  /** Quotes and builds the transaction. Throws when the provider cannot route it. */
  build(req: RouteRequest): Promise<BuiltStep>;
}
