import { getLifiQuote } from "../adapters/lifi.js";
import { OrchestratorError } from "../execution/shared.js";
import type { RouteProvider } from "./types.js";

export const lifi: RouteProvider = {
  id: "lifi",
  kind: "bridge",
  supports: () => true,
  priority: () => ((process.env.BRIDGE_PRIMARY ?? "relay").toLowerCase() === "lifi" ? 0 : 1),
  async build({ step, amountIn, fromAddress, recipientAddress, outputTokenAddress, outputDecimals }) {
    const quote = await getLifiQuote({
      fromChain: step.chainFrom,
      fromToken: step.tokenIn,
      fromAmount: amountIn,
      fromAddress,
      toChain: step.chainTo,
      toToken: step.tokenOut,
      toAddress: recipientAddress,
    });
    if (!quote.transactionRequest) throw new OrchestratorError("LI.FI quote returned no transactionRequest", step.id);
    return { tx: quote.transactionRequest, outputSymbol: step.tokenOut, outputTokenAddress, outputDecimals, bridgeAdapter: "lifi" };
  },
};
