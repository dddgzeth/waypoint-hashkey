/**
 * The capability registry. To add an action, write a module that implements
 * `Capability` and list it once in CAPABILITIES below; the planner prompt, the
 * structured-output schema, validation, execution dispatch and the capability
 * map (GET /capabilities) all derive from this list.
 */
import type { ChainConfig } from "../chains/types.js";
import type { ExecutionPlan, PlanStep } from "../models.js";
import type { Capability } from "./types.js";
import { swap } from "./swap.js";
import { bridge } from "./bridge.js";
import { crossChainSwap } from "./crossChainSwap.js";
import { protocolSupply } from "./protocolSupply.js";
import { protocolWithdraw } from "./protocolWithdraw.js";
import { protocolBorrow } from "./protocolBorrow.js";
import { transfer } from "./transfer.js";
import { customCall } from "./customCall.js";
import { wrapNative, unwrapNative } from "./wrapNative.js";
import { deployContract } from "./deployContract.js";

export { PlanValidationError } from "./types.js";
export type { Capability, StepValidationContext, PlanValidationContext, PositionRef } from "./types.js";

const CAPABILITIES: Capability[] = [swap, bridge, crossChainSwap, protocolSupply, protocolWithdraw, protocolBorrow, transfer, customCall, wrapNative, unwrapNative, deployContract];

const BY_ID = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));
if (BY_ID.size !== CAPABILITIES.length) throw new Error("Duplicate capability id in the registry");

export function allCapabilities(): readonly Capability[] {
  return CAPABILITIES;
}

export function getCapability(id: string): Capability | undefined {
  return BY_ID.get(id);
}

/** Action ids in registration order, as the non-empty tuple zod's enum needs. */
export function capabilityIds(): [string, ...string[]] {
  return CAPABILITIES.map((capability) => capability.id) as [string, ...string[]];
}

/** The planner prompt's list of allowed actions. */
export function actionListText(): string {
  return CAPABILITIES.map((capability) => capability.id).join(" / ");
}

/** Each capability's own planner rules, concatenated in registration order. */
export function actionRulesText(): string {
  return CAPABILITIES.map((capability) => capability.promptRules.trim()).filter(Boolean).join("\n");
}

/** Rows are capabilities, columns are chains: the matrix the capability map shows. */
export function capabilityMatrix(chains: readonly ChainConfig[]) {
  return {
    chains: chains.map((chain) => ({ key: chain.key, label: chain.label })),
    capabilities: CAPABILITIES.map((capability) => ({
      id: capability.id,
      label: capability.label,
      summary: capability.summary,
      chains: chains.filter((chain) => capability.availableOn(chain)).map((chain) => chain.key),
    })),
  };
}

function describeStep(step: PlanStep): string {
  const custom = getCapability(step.action)?.describe;
  if (custom) return custom(step);
  const dep = step.dependsOn.length ? ` (depends on: ${step.dependsOn.join(", ")})` : "";
  const proto = step.protocol ? ` via ${step.protocol}` : "";
  const from = step.transferFrom ? ` from ${step.transferFrom}` : "";
  const to = step.transferTo ? ` -> lands in ${step.transferTo}` : "";
  return (
    `  [${step.id}] ${step.action}:${from} ${step.amountIn} ${step.tokenIn} (${step.chainFrom}) -> ` +
    `${step.tokenOut} (${step.chainTo})${proto} [adapter=${step.vendorAdapter}]${to}${dep}`
  );
}

export function prettyPlan(plan: ExecutionPlan): string {
  const lines = [`Goal: ${plan.goal.action}`];
  if (plan.goal.constraints.length > 0) {
    lines.push(`Constraints: ${plan.goal.constraints.join(", ")}`);
  }
  lines.push("Execution plan:");
  for (const step of plan.steps) lines.push(describeStep(step));
  return lines.join("\n");
}
