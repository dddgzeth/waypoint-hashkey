import { PlanValidationError, type Capability } from "./types.js";
import { buildRoutedStep } from "./routing.js";

export const bridge: Capability = {
  id: "bridge",
  label: "Bridge",
  summary: "Move a token from one chain to another.",
  availableOn: () => true,
  promptRules: `- Cross-chain movement (bridge / cross_chain_swap) should leave vendorAdapter null unless the user
  explicitly selects a provider. The execution router applies its bridge provider order and fallback;
  do not pin a vendor in the plan.`,
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
