import { encodeFunctionData, erc20Abi, formatUnits, parseUnits } from "viem";
import type { PublicClient } from "viem";
import type { PlanStep } from "../models.js";
import { getChain } from "../chains/index.js";
import { getAaveSupplyApy } from "../adapters/aaveYield.js";
import { OrchestratorError, type BuiltStep, type StepResult } from "../execution/shared.js";
import { PlanValidationError, type Capability } from "./types.js";

async function buildTx(
  step: PlanStep,
  resolvedAmountIn: number,
  fromAddress: `0x${string}`,
  recipientAddress: `0x${string}`
): Promise<BuiltStep> {
    if (step.protocol?.toLowerCase() !== "aave") {
      throw new OrchestratorError(`No execution adapter for protocol "${step.protocol}" yet — only Aave is wired up`, step.id);
    }
    const aave = await getAaveSupplyApy(step.chainTo, step.tokenOut);
    const pool = getChain(step.chainTo)?.aavePool;
    if (!pool) throw new OrchestratorError(`Aave is not available on ${step.chainTo}`, step.id);
    // Aave V3 aTokens always mirror their underlying asset's decimals exactly
    // (a protocol invariant, not an assumption) — planner.ts's prompt already
    // requires tokenOut === tokenIn for protocol_supply, so step.tokenOut's
    // decimals is the right value here regardless of which asset this is,
    // not just USDC.
    const underlyingDecimals = aave.decimals;
    const amount = parseUnits(String(resolvedAmountIn), underlyingDecimals);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "supply",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "onBehalfOf", type: "address" },
            { name: "referralCode", type: "uint16" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "supply",
      args: [aave.underlyingAddress, amount, recipientAddress, 0],
    });
    return {
      tx: { to: pool, data, value: "0x0" },
      outputSymbol: `a${step.tokenOut.toUpperCase()}`,
      outputTokenAddress: aave.aTokenAddress,
      outputDecimals: underlyingDecimals,
    };
}

export const protocolSupply: Capability = {
  id: "protocol_supply",
  label: "Supply",
  summary: "Deposit an asset into a lending market to earn yield.",
  availableOn: (chain) => Boolean(chain.aavePool),
  promptRules: `- A protocol_supply step's tokenOut must equal its tokenIn (it's depositing the same
  asset it received — never leave it blank or invent a different token)`,
  validateStep(step, ctx) {
    const refStep = ctx.refStep;
    if (
      refStep &&
      refStep.action === "protocol_withdraw" &&
      step.chainFrom.toLowerCase() === refStep.chainTo.toLowerCase() &&
      step.tokenIn.toLowerCase() === refStep.tokenOut.toLowerCase() &&
      (step.transferFrom ?? "").toLowerCase() === (refStep.transferFrom ?? "").toLowerCase()
    ) {
      throw new PlanValidationError(
        `${step.id}: withdrawing an Aave position only to re-supply the same asset to the same wallet is redundant collateral churn`
      );
    }
  },
  validatePlan(plan, ctx) {
    const requiredDeposit = ctx.requiredDeposit;
    if (!requiredDeposit) return;
    const supplies = plan.steps.filter((step) => step.action === "protocol_supply");
    if (!supplies.length) throw new PlanValidationError("The plan has no Aave supply step for the live yield destination");
    for (const supply of supplies) {
      if (
        supply.protocol?.toLowerCase() !== "aave" ||
        supply.chainFrom.toLowerCase() !== requiredDeposit.chain ||
        supply.chainTo.toLowerCase() !== requiredDeposit.chain ||
        supply.tokenIn.toUpperCase() !== requiredDeposit.asset ||
        supply.tokenOut.toUpperCase() !== requiredDeposit.asset
      ) {
        throw new PlanValidationError(
          `${supply.id}: Aave supply must use the live best-yield market ${requiredDeposit.asset} on ${requiredDeposit.chain}`
        );
      }
    }
  },
  buildTx,
  /** A confirmed Aave supply can be followed immediately by a dependent
   * borrow. Alchemy's load-balanced RPC keys do not always expose the new
   * collateral in the same instant as the receipt, so explicitly wait for
   * the real aToken balance instead of skipping receipt-token visibility. */
  async awaitOutputVisible(step: PlanStep, result: StepResult, recipient: `0x${string}`, clients: PublicClient[]): Promise<boolean> {
    const reserve = await getAaveSupplyApy(step.chainTo, step.tokenOut);
    for (let attempt = 0; attempt < 60; attempt++) {
      const balances = await Promise.all(clients.map(async (client) => {
        const raw = await client.readContract({
          address: reserve.aTokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [recipient],
        });
        return Number(formatUnits(raw, reserve.decimals));
      }));
      if (balances.every((balance) => balance + 1e-12 >= result.actualAmountOut)) return true;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new OrchestratorError(
      `${step.id}: Aave collateral supply is confirmed but its aToken balance is not yet visible through ${step.chainTo} RPC`,
      step.id
    );
  },
};
