import { getRelayQuote } from "../adapters/relay.js";
import { OrchestratorError } from "../execution/shared.js";
import type { RouteProvider } from "./types.js";

export const relay: RouteProvider = {
  id: "relay",
  kind: "bridge",
  // Relay carries cross-chain movement; a same-chain route only when the plan pins it explicitly.
  supports: (step) => step.chainFrom !== step.chainTo || step.vendorAdapter?.toLowerCase() === "relay",
  priority: () => ((process.env.BRIDGE_PRIMARY ?? "relay").toLowerCase() === "lifi" ? 1 : 0),
  async build({ step, amountIn, fromAddress, recipientAddress, outputTokenAddress, outputDecimals }) {
    const quote = await getRelayQuote({
      fromChain: step.chainFrom,
      fromToken: step.tokenIn,
      fromAmount: amountIn,
      fromAddress,
      toChain: step.chainTo,
      toToken: step.tokenOut,
      toAddress: recipientAddress,
    });
    if (!quote.transactionRequest) throw new OrchestratorError("Relay quote returned no transactionRequest", step.id);
    return {
      tx: quote.transactionRequest,
      outputSymbol: step.tokenOut,
      outputTokenAddress,
      outputDecimals,
      bridgeAdapter: "relay",
      relayRequestId: quote.requestId,
      approvalSpender: quote.approvalSpender ?? undefined,
    };
  },
};
