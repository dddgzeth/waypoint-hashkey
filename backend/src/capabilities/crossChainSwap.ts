import { PlanValidationError, type Capability } from "./types.js";
import { buildRoutedStep } from "./routing.js";

export const crossChainSwap: Capability = {
  id: "cross_chain_swap",
  label: "Cross-chain swap",
  summary: "Exchange a token on one chain for a different token on another chain.",
  availableOn: () => true,
  promptRules: "",
  refreshQuoteBeforeSend: true,
  validateStep(step) {
    if (step.chainFrom.toLowerCase() === step.chainTo.toLowerCase()) {
      throw new PlanValidationError(
        `${step.id}: action=${step.action} but chainFrom and chainTo are the same chain (${step.chainFrom}) — should be swap`
      );
    }
  },
  buildTx: buildRoutedStep,
};
