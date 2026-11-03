import { createPublicClient, createWalletClient, parseAbiItem } from "viem";
import type { Account } from "viem";
import type { PlanStep } from "../models.js";
import { VIEM_CHAIN } from "../tokenRegistry.js";
import { alchemyHttp } from "../adapters/alchemyTransport.js";
import { encodeCustomCall } from "../customCall/execute.js";
import {
  OrchestratorError,
  simulate,
  pendingNonce,
  gasLimitWithHeadroom,
  type ClientStepBuild,
  type ProgressCallback,
  type StepResult,
  type TxRequest, walletClientFor } from "../execution/shared.js";
import { PlanValidationError, type Capability } from "./types.js";

/**
 * custom_call steps don't fit the swap/bridge/protocol_supply shape (no
 * tokenIn amount, no measurable token output — the escape-hatch action type
 * can be calling anything, e.g. a governance vote that moves no tokens at
 * all). Handled as its own path: cap by native value sent, simulate, send,
 * confirm — no Transfer-log output measurement.
 */
async function runCustomCallStep(step: PlanStep, account: Account, onProgress?: ProgressCallback): Promise<StepResult> {
  const valueEth = step.customCallValueEth ?? "0";
  if (!step.customCallTarget || !step.customCallFunction) {
    throw new OrchestratorError("custom_call step missing customCallTarget/customCallFunction", step.id);
  }

  const encoded = encodeCustomCall({
    target: step.customCallTarget,
    functionSignature: step.customCallFunction,
    args: step.customCallArgs ?? [],
    valueEth,
  });

  console.log(`  [${step.id}] simulating custom_call (eth_call)...`);
  onProgress?.({ type: "step_status", stepId: step.id, status: "simulating", detail: `${step.customCallTarget}.${step.customCallFunction}` });
  await simulate(step.chainFrom, { to: encoded.to, data: encoded.data, value: `0x${encoded.value.toString(16)}` }, account.address);
  console.log(`  [${step.id}] simulation OK, no revert`);

  const walletClient = walletClientFor(account, step.chainFrom);
  onProgress?.({ type: "step_status", stepId: step.id, status: "sending" });
  const txHash = await walletClient.sendTransaction({
    to: encoded.to,
    data: encoded.data,
    value: encoded.value,
    gas: await gasLimitWithHeadroom(step.chainFrom, account.address, { to: encoded.to, data: encoded.data, value: encoded.value }),
    nonce: await pendingNonce(step.chainFrom, account.address),
  });
  console.log(`  [${step.id}] tx sent: ${txHash} — waiting for confirmation...`);
  onProgress?.({ type: "step_tx", stepId: step.id, label: "source", chainKey: step.chainFrom, txHash });

  const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  onProgress?.({ type: "step_status", stepId: step.id, status: "confirming" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new OrchestratorError(`Transaction ${txHash} reverted on-chain despite passing simulation`, step.id, txHash);
  }
  console.log(`  [${step.id}] confirmed in block ${receipt.blockNumber}`);

  return {
    stepId: step.id,
    txHash,
    resolvedAmountIn: Number(valueEth),
    actualAmountOut: 0,
    outputSymbol: "custom_call",
    gasUsed: receipt.gasUsed.toString(),
  };
}

async function buildClientCustomCall(step: PlanStep, resolvedAmountIn: number, fromAddress: `0x${string}`): Promise<ClientStepBuild> {
if (!step.customCallTarget || !step.customCallFunction) {
  throw new OrchestratorError("custom_call step missing customCallTarget/customCallFunction", step.id);
}
const encoded = encodeCustomCall({
  target: step.customCallTarget,
  functionSignature: step.customCallFunction,
  args: step.customCallArgs ?? [],
  valueEth: step.customCallValueEth ?? "0",
});
const tx: TxRequest = { to: encoded.to, data: encoded.data, value: `0x${encoded.value.toString(16)}` as `0x${string}` };
await simulate(step.chainFrom, tx, fromAddress);
return {
  tx,
  approvalTx: null,
  outputSymbol: "custom_call",
  outputTokenAddress: null,
  outputDecimals: 18,
  resolvedAmountIn: Number(step.customCallValueEth ?? "0"),
};
}

export const customCall: Capability = {
  id: "custom_call",
  label: "Contract call",
  summary: "Call any function on any contract: the escape hatch for operations no integration covers.",
  availableOn: () => true,
  promptRules: `- custom_call is the escape hatch for on-chain operations that don't fit any of the
  other 4 actions (e.g. calling an arbitrary contract method not covered by a known
  protocol integration). Only use it when nothing else fits. For a custom_call step:
  set chainFrom = chainTo = the chain the call happens on, set tokenIn/tokenOut to that
  chain's native token symbol and amountIn to "0" (these 3 fields are unused
  placeholders for this action type), and fill in customCallTarget (the contract
  address), customCallFunction (a human-readable Solidity function signature, e.g.
  "function approve(address spender, uint256 amount) returns (bool)"), customCallArgs
  (the arguments in order, as strings), and customCallValueEth (native value to send,
  as a plain decimal string, or "0"). To call a contract that an earlier deploy_contract step
  creates, set customCallTarget to "deployed_by(<that step id>)" and list that step in dependsOn.
  For every other action type, leave
  customCallTarget/customCallFunction/customCallArgs/customCallValueEth null.`,
  describe: (s) => {
    const dep = s.dependsOn.length ? ` (depends on: ${s.dependsOn.join(", ")})` : "";
    return (
      `  [${s.id}] custom_call: ${s.customCallTarget}.${s.customCallFunction} (${s.customCallArgs?.join(", ")}) ` +
      `on ${s.chainFrom}, value=${s.customCallValueEth}${dep}`
    );
  },
  validateStep(step, ctx) {
    if (step.chainFrom.toLowerCase() !== step.chainTo.toLowerCase()) {
      throw new PlanValidationError(`${step.id}: custom_call must have chainFrom === chainTo`);
    }
    // A contract deployed earlier in the same plan is addressed as deployed_by(<deploy step id>).
    const deployedBy = /^deployed_by\(([^)]+)\)$/.exec(step.customCallTarget ?? "");
    if (deployedBy) {
      const deployStep = ctx.stepsById.get(deployedBy[1]);
      if (deployStep?.action !== "deploy_contract") {
        throw new PlanValidationError(`${step.id}: ${step.customCallTarget} must name an earlier deploy_contract step`);
      }
      if (!step.dependsOn.includes(deployedBy[1])) {
        throw new PlanValidationError(`${step.id}: calls the contract deployed by ${deployedBy[1]} but dependsOn doesn't declare that dependency`);
      }
      if (deployStep.chainTo.toLowerCase() !== step.chainFrom.toLowerCase()) {
        throw new PlanValidationError(`${step.id}: the contract was deployed on ${deployStep.chainTo}, not ${step.chainFrom}`);
      }
    } else if (!step.customCallTarget || !/^0x[a-fA-F0-9]{40}$/.test(step.customCallTarget)) {
      throw new PlanValidationError(`${step.id}: custom_call requires a valid customCallTarget address`);
    }
    if (!step.customCallFunction) {
      throw new PlanValidationError(`${step.id}: custom_call requires customCallFunction`);
    }
    let parsedFn;
    try {
      parsedFn = parseAbiItem(step.customCallFunction);
    } catch {
      throw new PlanValidationError(
        `${step.id}: customCallFunction "${step.customCallFunction}" isn't a valid Solidity function signature`
      );
    }
    if (parsedFn.type !== "function") {
      throw new PlanValidationError(`${step.id}: customCallFunction must be a function signature`);
    }
    const argCount = step.customCallArgs?.length ?? 0;
    if (argCount !== parsedFn.inputs.length) {
      throw new PlanValidationError(
        `${step.id}: ${step.customCallFunction} expects ${parsedFn.inputs.length} args, customCallArgs has ${argCount}`
      );
    }
  },
  run: (step, _resolvedAmountIn, account, onProgress) => runCustomCallStep(step, account, onProgress),
  buildClient: buildClientCustomCall,
  confirmClient: (step, built, txHash, receipt) => {
    return {
      stepId: step.id,
      txHash,
      resolvedAmountIn: built.resolvedAmountIn,
      actualAmountOut: 0,
      outputSymbol: "custom_call",
      gasUsed: receipt.gasUsed.toString(),
    };
  },
};
