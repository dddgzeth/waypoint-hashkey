import { NATIVE_PLACEHOLDER_EEEE } from "../tokenRegistry.js";
import { getEnsoRoute } from "../adapters/enso.js";
import { OrchestratorError } from "../execution/shared.js";
import type { RouteProvider } from "./types.js";

export const enso: RouteProvider = {
  id: "enso",
  kind: "swap",
  supports: (step) => step.chainFrom !== "hashkey",
  priority: (step) => ((step.vendorAdapter?.toLowerCase() ?? process.env.SAME_CHAIN_SWAP_PRIMARY ?? "enso") === "okx" ? 1 : 0),
  async build({ step, amountIn, fromAddress, recipientAddress, outputTokenAddress, outputDecimals }) {
    const routeOutputAddress = outputTokenAddress ?? NATIVE_PLACEHOLDER_EEEE;
    if (!routeOutputAddress) throw new OrchestratorError(`Same-chain swap output ${step.tokenOut} has no known token address`, step.id);
    const route = await getEnsoRoute({
      chainKey: step.chainFrom,
      fromAddress,
      tokenInSymbol: step.tokenIn,
      tokenOutAddress: routeOutputAddress,
      tokenOutDecimals: outputDecimals,
      amountIn,
      receiverAddress: recipientAddress,
    });
    return {
      tx: { to: route.transactionRequest.to, data: route.transactionRequest.data, value: route.transactionRequest.value },
      outputSymbol: step.tokenOut,
      outputTokenAddress,
      outputDecimals,
    };
  },
};
