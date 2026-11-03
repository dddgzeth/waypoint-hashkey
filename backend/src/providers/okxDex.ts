import { getOkxDexSwapRoute } from "../adapters/okxDex.js";
import type { RouteProvider } from "./types.js";

/** OKX's DEX aggregator: documented single-chain routes only. */
export const okxDex: RouteProvider = {
  id: "okx",
  kind: "swap",
  supports: (step) => step.chainFrom !== "hashkey",
  priority: (step) => ((step.vendorAdapter?.toLowerCase() ?? process.env.SAME_CHAIN_SWAP_PRIMARY ?? "enso") === "okx" ? 0 : 1),
  async build({ step, amountIn, fromAddress, recipientAddress, outputTokenAddress, outputDecimals }) {
    const route = await getOkxDexSwapRoute({
      chainKey: step.chainFrom,
      fromAddress,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn,
      recipientAddress,
    });
    return {
      tx: route.transactionRequest,
      outputSymbol: step.tokenOut,
      outputTokenAddress,
      outputDecimals,
      approvalSpender: route.approvalSpender ?? undefined,
    };
  },
};
