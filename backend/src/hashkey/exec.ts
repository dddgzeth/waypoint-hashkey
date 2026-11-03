/** One swap on HashKey Swap, sent through the same simulate-then-send pipeline every plan uses. */
import type { Account } from "viem";
import type { ExecutionPlan } from "../models.js";
import { runPlan, type StepResult } from "../orchestrator.js";

export async function swapOnHashkey(account: Account, tokenIn: string, tokenOut: string, amountIn: number, label: string): Promise<StepResult> {
  const plan: ExecutionPlan = {
    goal: {
      targetChain: "hashkey",
      targetAsset: tokenOut,
      action: label,
      constraints: [],
      sourceWalletLabels: [],
      existingProtocolPositions: "preserve",
      needsYieldLookup: false,
    },
    steps: [
      {
        id: "hashkey-swap",
        action: "swap",
        chainFrom: "hashkey",
        chainTo: "hashkey",
        tokenIn,
        tokenOut,
        amountIn: String(amountIn),
        protocol: null,
        dependsOn: [],
        transferTo: null,
        transferFrom: null,
        vendorAdapter: null,
        customCallTarget: null,
        customCallFunction: null,
        customCallArgs: null,
        customCallValueEth: null,
        deployIntent: null,
        deployContractName: null,
        deploySource: null,
        deployConstructorArgs: null,
      },
    ],
  };
  const [result] = await runPlan(plan, account);
  return result;
}
