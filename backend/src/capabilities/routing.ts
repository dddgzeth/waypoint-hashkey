/**
 * Route building shared by swap, bridge and cross_chain_swap: works out the
 * output token, then hands the step to the provider router (providers/), which
 * picks the provider, applies the fallback and records what it learns.
 */
import type { PlanStep } from "../models.js";
import { NATIVE_SYMBOL } from "../tokenRegistry.js";
import { resolveTokenReference, tokenReferenceDecimals } from "../tokenReference.js";
import { OrchestratorError, type BuiltStep } from "../execution/shared.js";
import { routeKind, routeStep } from "../providers/router.js";

export async function buildRoutedStep(
  step: PlanStep,
  resolvedAmountIn: number,
  fromAddress: `0x${string}`,
  recipientAddress: `0x${string}`
): Promise<BuiltStep> {
  const isNativeOut = step.tokenOut.toUpperCase() === NATIVE_SYMBOL[step.chainTo];
  const outputTokenAddress = isNativeOut ? null : (resolveTokenReference(step.chainTo, step.tokenOut) ?? null);
  const outputDecimals = await tokenReferenceDecimals(step.chainTo, step.tokenOut);
  if (routeKind(step) === "swap" && !isNativeOut && !outputTokenAddress) {
    throw new OrchestratorError(`Same-chain swap output ${step.tokenOut} has no known token address`, step.id);
  }
  return routeStep({ step, amountIn: resolvedAmountIn, fromAddress, recipientAddress, outputTokenAddress, outputDecimals });
}
