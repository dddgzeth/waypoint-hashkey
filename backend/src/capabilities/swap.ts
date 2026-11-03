import { PlanValidationError, type Capability } from "./types.js";
import { buildRoutedStep } from "./routing.js";

export const swap: Capability = {
  id: "swap",
  label: "Swap",
  summary: "Exchange one token for another on the same chain.",
  availableOn: () => true,
  promptRules: `- Same-chain swaps should leave vendorAdapter null unless the user explicitly
  selects a provider. The execution router applies its live same-chain
  provider policy and fallback; do not pin a vendor in the plan.
- Never generate a swap step where chainFrom/chainTo are the same chain AND
  tokenIn/tokenOut are the same token — that's a no-op and is not allowed`,
  refreshQuoteBeforeSend: true,
  validateStep(step) {
    const sameChain = step.chainFrom.toLowerCase() === step.chainTo.toLowerCase();
    if (sameChain && step.tokenIn.toLowerCase() === step.tokenOut.toLowerCase()) {
      // The prompt already tells the model not to generate this, but testing showed
      // it doesn't always comply — deterministic code backstops it here. This is
      // exactly the "LLM proposes, code validates" scenario plan.md calls for.
      throw new PlanValidationError(
        `${step.id}: no-op swap (same chain, same token ${step.tokenIn}) — the model generated a redundant step`
      );
    }
    if (!sameChain) {
      // Testing showed the model sometimes labels a cross-chain swap as plain "swap"
      // instead of "cross_chain_swap" — the action type determines which vendor
      // adapter gets used (same-chain -> DEX/Enso, cross-chain -> Relay/LI.FI), so a
      // wrong label sends the Orchestrator to the wrong adapter. Must catch it here;
      // can't rely on the model labeling it correctly every time.
      throw new PlanValidationError(
        `${step.id}: action=swap but chainFrom(${step.chainFrom}) != chainTo(${step.chainTo}) — should be cross_chain_swap`
      );
    }
  },
  buildTx: buildRoutedStep,
};
