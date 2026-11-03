import { encodeFunctionData, parseUnits } from "viem";
import type { PlanStep } from "../models.js";
import { getChain } from "../chains/index.js";
import { getAaveBorrowMarket } from "../adapters/aaveYield.js";
import { OrchestratorError, type BuiltStep } from "../execution/shared.js";
import { PlanValidationError, type Capability } from "./types.js";

async function buildTx(
  step: PlanStep,
  resolvedAmountIn: number,
  fromAddress: `0x${string}`,
  recipientAddress: `0x${string}`
): Promise<BuiltStep> {
    if (step.protocol?.toLowerCase() !== "aave") {
      throw new OrchestratorError(`No borrowing adapter for protocol "${step.protocol}" yet — only Aave is wired up`, step.id);
    }
    const aave = await getAaveBorrowMarket(step.chainTo, step.tokenOut);
    const pool = getChain(step.chainTo)?.aavePool;
    if (!pool) throw new OrchestratorError(`Aave is not available on ${step.chainTo}`, step.id);
    const amount = parseUnits(String(resolvedAmountIn), aave.decimals);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "borrow",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "interestRateMode", type: "uint256" },
            { name: "referralCode", type: "uint16" },
            { name: "onBehalfOf", type: "address" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "borrow",
      args: [aave.underlyingAddress, amount, 2n, 0, fromAddress],
    });
    return {
      tx: { to: pool, data, value: "0x0" },
      outputSymbol: aave.symbol,
      outputTokenAddress: aave.underlyingAddress,
      outputDecimals: aave.decimals,
    };
}

export const protocolBorrow: Capability = {
  id: "protocol_borrow",
  label: "Borrow",
  summary: "Borrow an asset against collateral already supplied to a lending market.",
  availableOn: (chain) => Boolean(chain.aavePool),
  promptRules: `- A protocol_borrow step borrows from an existing Aave collateral position. Set
  protocol="aave", tokenIn=tokenOut to the asset being borrowed, use the same
  chain for chainFrom/chainTo, and put the requested borrowed token amount in
  amountIn. Leave transferTo null: Aave sends the borrowed asset to the signer;
  use a later transfer step if the user wants it sent elsewhere. When the
  collateral is already supplied, do not withdraw and re-supply it just to
  borrow; preserve the existing collateral and emit only the borrow step.`,
  approvesInput: false,
  clientApprovesInput: false,
  validateStep(step) {
    if (
      step.protocol?.toLowerCase() !== "aave" ||
      step.chainFrom.toLowerCase() !== step.chainTo.toLowerCase() ||
      step.tokenIn.toLowerCase() !== step.tokenOut.toLowerCase() ||
      step.transferTo
    ) {
      throw new PlanValidationError(
        `${step.id}: an Aave borrow must stay on one chain, use the borrowed asset as tokenIn/tokenOut, and return it to the signer`
      );
    }
  },
  buildTx,
};
