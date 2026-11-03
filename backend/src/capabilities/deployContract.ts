/**
 * deploy_contract: the agent writes a smart contract for a strategy no existing
 * integration covers, the platform compiles and audits it, and a later
 * custom_call step uses it as deployed_by(<this step>). The planner only
 * describes what the contract must do (deployIntent); prepareStep hands that
 * to the contract-authoring stage (contracts/author.ts), so the plan the user
 * confirms already contains the final source.
 */
import { createPublicClient, createWalletClient, encodeDeployData } from "viem";
import type { Account } from "viem";
import type { PlanStep } from "../models.js";
import { VIEM_CHAIN } from "../tokenRegistry.js";
import { alchemyHttp } from "../adapters/alchemyTransport.js";
import { coerceArgs } from "../customCall/execute.js";
import { authorContract, ContractAuthoringError } from "../contracts/author.js";
import { compileSolidity } from "../contracts/compiler.js";
import { OrchestratorError, pendingNonce, type ProgressCallback, type StepResult, walletClientFor } from "../execution/shared.js";
import { PlanValidationError, type Capability } from "./types.js";

async function runDeploy(step: PlanStep, account: Account, onProgress?: ProgressCallback): Promise<StepResult> {
  if (!step.deploySource) throw new OrchestratorError("deploy_contract step has no contract source", step.id);
  // The server compiles the source itself; a plan never carries bytecode it did not produce.
  const compiled = compileSolidity(step.deploySource, step.deployContractName ?? undefined);
  const constructor = compiled.abi.find((item) => item.type === "constructor");
  const args = coerceArgs(constructor && "inputs" in constructor ? constructor.inputs : [], step.deployConstructorArgs ?? []);
  const data = encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode, args });

  const chain = VIEM_CHAIN[step.chainFrom];
  const publicClient = createPublicClient({ chain, transport: alchemyHttp(step.chainFrom) });
  onProgress?.({ type: "step_status", stepId: step.id, status: "simulating", detail: `Deploying ${compiled.name}` });
  // A call with no `to` simulates the creation transaction; a revert in the constructor surfaces here.
  await publicClient.call({ account: account.address, data });
  const estimate = await publicClient.estimateGas({ account: account.address, data });

  const walletClient = walletClientFor(account, step.chainFrom);
  onProgress?.({ type: "step_status", stepId: step.id, status: "sending" });
  const txHash = await walletClient.sendTransaction({
    data,
    gas: (estimate * 130n) / 100n,
    nonce: await pendingNonce(step.chainFrom, account.address),
  });
  onProgress?.({ type: "step_tx", stepId: step.id, label: "source", chainKey: step.chainFrom, txHash });
  onProgress?.({ type: "step_status", stepId: step.id, status: "confirming" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new OrchestratorError(`Deployment ${txHash} failed on-chain`, step.id, txHash);
  }
  // A following step reads this contract through a possibly different RPC node; wait until the code is visible.
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = await publicClient.getCode({ address: receipt.contractAddress });
    if (code && code !== "0x") break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return {
    stepId: step.id,
    txHash,
    resolvedAmountIn: 0,
    actualAmountOut: 0,
    outputSymbol: compiled.name,
    gasUsed: receipt.gasUsed.toString(),
    deployedContract: { chain: step.chainFrom, address: receipt.contractAddress, name: compiled.name, source: step.deploySource, abi: compiled.abi as unknown[] },
  };
}

export const deployContract: Capability = {
  id: "deploy_contract",
  label: "Deploy",
  summary: "Write and deploy a smart contract for a strategy no existing integration covers, then call it.",
  availableOn: () => true,
  promptRules: `- deploy_contract deploys a new smart contract that the agent writes, so later steps can call it.
  Use it only when no existing action does the job (for example a custom atomic arbitrage or a small
  utility contract). Set chainFrom = chainTo, tokenIn/tokenOut to that chain's native token symbol and
  amountIn to "0" (placeholders), and set deployIntent to a precise description of what the contract
  must do: its purpose, every address it must use, and the exact Solidity signature of every external
  function that later steps will call. Leave deployContractName, deploySource and deployConstructorArgs
  null: a separate stage writes the contract. Never write contract source code in the plan yourself.
  A later custom_call step reaches the new contract with customCallTarget "deployed_by(<deploy step id>)",
  lists the deploy step in dependsOn, and its customCallFunction must be one of the signatures named in
  deployIntent.`,
  describe: (s) => {
    const dep = s.dependsOn.length ? ` (depends on: ${s.dependsOn.join(", ")})` : "";
    return `  [${s.id}] deploy_contract: ${s.deployContractName ?? "contract"} on ${s.chainFrom} — ${s.deployIntent ?? ""}${dep}`;
  },
  validateStep(step) {
    if (step.chainFrom.toLowerCase() !== step.chainTo.toLowerCase()) {
      throw new PlanValidationError(`${step.id}: deploy_contract must have chainFrom === chainTo`);
    }
    if (!step.deployIntent?.trim() && !step.deploySource) {
      throw new PlanValidationError(`${step.id}: deploy_contract requires deployIntent describing the contract`);
    }
  },
  async prepareStep(step, plan) {
    if (step.deploySource) return step;
    const callTarget = `deployed_by(${step.id})`;
    const requiredFunctions = plan.steps
      .filter((other) => other.action === "custom_call" && other.customCallTarget === callTarget && other.customCallFunction)
      .map((other) => other.customCallFunction as string);
    try {
      const authored = await authorContract({ intent: step.deployIntent ?? "", chain: step.chainFrom, requiredFunctions });
      return { ...step, deployContractName: authored.contractName, deploySource: authored.source, deployConstructorArgs: authored.constructorArgs };
    } catch (err) {
      if (err instanceof ContractAuthoringError) throw new PlanValidationError(`${step.id}: ${err.message}`);
      throw err;
    }
  },
  run: (step, _amount, account, onProgress) => runDeploy(step, account, onProgress),
  buildClient: async (step) => {
    throw new OrchestratorError("Deploying a contract is only available from an execution wallet", step.id);
  },
};
