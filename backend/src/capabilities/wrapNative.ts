/**
 * wrap_native / unwrap_native: convert a chain's native token to its wrapped ERC-20 (WETH-style deposit/withdraw)
 * and back, 1:1. Added to the platform as one module here plus two lines in ./index.ts; the planner prompt, the
 * structured-output schema, validation, execution and the capability map all pick it up from the registry.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, parseAbi, parseUnits } from "viem";
import type { Account } from "viem";
import type { PlanStep } from "../models.js";
import { VIEM_CHAIN } from "../tokenRegistry.js";
import { CHAINS, getChain } from "../chains/index.js";
import { alchemyHttp } from "../adapters/alchemyTransport.js";
import {
  OrchestratorError,
  simulate,
  pendingNonce,
  gasLimitWithHeadroom,
  type BuiltStep,
  type ClientStepBuild,
  type ProgressCallback,
  type StepResult, walletClientFor } from "../execution/shared.js";
import { PlanValidationError, type Capability } from "./types.js";

const WRAPPED_ABI = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);

function wrappedOf(chainKey: string, stepId: string) {
  const wrapped = getChain(chainKey)?.wrappedNative;
  if (!wrapped) throw new OrchestratorError(`${chainKey} has no wrapped native token configured`, stepId);
  return wrapped;
}

function tx(step: PlanStep, amount: number, direction: "wrap" | "unwrap") {
  const wrapped = wrappedOf(step.chainFrom, step.id);
  const wei = parseUnits(String(amount), 18);
  return direction === "wrap"
    ? { to: wrapped.address, data: encodeFunctionData({ abi: WRAPPED_ABI, functionName: "deposit" }), value: `0x${wei.toString(16)}` as `0x${string}` }
    : { to: wrapped.address, data: encodeFunctionData({ abi: WRAPPED_ABI, functionName: "withdraw", args: [wei] }), value: "0x0" as `0x${string}` };
}

function built(step: PlanStep, amount: number, direction: "wrap" | "unwrap"): BuiltStep {
  const chain = getChain(step.chainFrom)!;
  return {
    tx: tx(step, amount, direction),
    outputSymbol: direction === "wrap" ? chain.wrappedNative!.symbol : chain.nativeSymbol,
    outputTokenAddress: direction === "wrap" ? chain.wrappedNative!.address : null,
    outputDecimals: 18,
  };
}

async function run(direction: "wrap" | "unwrap", step: PlanStep, amount: number, account: Account, onProgress?: ProgressCallback): Promise<StepResult> {
  const b = built(step, amount, direction);
  onProgress?.({ type: "step_status", stepId: step.id, status: "simulating", detail: `${direction} ${amount} on ${step.chainFrom}` });
  await simulate(step.chainFrom, b.tx, account.address);
  const walletClient = walletClientFor(account, step.chainFrom);
  onProgress?.({ type: "step_status", stepId: step.id, status: "sending" });
  const txHash = await walletClient.sendTransaction({
    to: b.tx.to,
    data: b.tx.data,
    value: BigInt(b.tx.value),
    gas: await gasLimitWithHeadroom(step.chainFrom, account.address, { to: b.tx.to, data: b.tx.data, value: BigInt(b.tx.value) }),
    nonce: await pendingNonce(step.chainFrom, account.address),
  });
  onProgress?.({ type: "step_tx", stepId: step.id, label: "source", chainKey: step.chainFrom, txHash });
  const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  onProgress?.({ type: "step_status", stepId: step.id, status: "confirming" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new OrchestratorError(`Transaction ${txHash} reverted on-chain despite passing simulation`, step.id, txHash);
  }
  // Wrapping and unwrapping are exactly 1:1, so the amount received is the amount sent.
  return { stepId: step.id, txHash, resolvedAmountIn: amount, actualAmountOut: amount, outputSymbol: b.outputSymbol, gasUsed: receipt.gasUsed.toString() };
}

function make(direction: "wrap" | "unwrap"): Capability {
  const id = direction === "wrap" ? "wrap_native" : "unwrap_native";
  const wrappedList = () =>
    Object.values(CHAINS)
      .filter((chain) => chain.wrappedNative)
      .map((chain) => `${chain.key}: ${chain.wrappedNative!.address} (${chain.wrappedNative!.symbol})`)
      .join("; ");
  return {
    id,
    label: direction === "wrap" ? "Wrap" : "Unwrap",
    summary: direction === "wrap" ? "Convert a chain's native token to its wrapped ERC-20, 1:1." : "Convert a wrapped native ERC-20 back to the chain's native token, 1:1.",
    availableOn: (chain) => Boolean(chain.wrappedNative),
    promptRules:
      direction === "wrap"
        ? `- ${id} converts the native token to its wrapped ERC-20 one-to-one on one chain (chainFrom = chainTo). Set tokenIn to the chain's native symbol and tokenOut to the wrapped token contract address. Wrapped native tokens: ${wrappedList()}.`
        : `- ${id} converts the wrapped native ERC-20 back to the native token one-to-one on one chain (chainFrom = chainTo). Set tokenIn to the wrapped token contract address and tokenOut to the chain's native symbol. Wrapped native tokens: ${wrappedList()}.`,
    approvesInput: false,
    clientApprovesInput: false,
    validateStep(step) {
      const chain = getChain(step.chainFrom.toLowerCase());
      if (step.chainFrom.toLowerCase() !== step.chainTo.toLowerCase()) {
        throw new PlanValidationError(`${step.id}: ${id} must have chainFrom === chainTo`);
      }
      if (!chain?.wrappedNative) {
        throw new PlanValidationError(`${step.id}: ${step.chainFrom} has no wrapped native token`);
      }
      const native = chain.nativeSymbol.toUpperCase();
      const wrapped = chain.wrappedNative.address.toLowerCase();
      const [from, to] = direction === "wrap" ? [step.tokenIn, step.tokenOut] : [step.tokenOut, step.tokenIn];
      if (from.toUpperCase() !== native || to.toLowerCase() !== wrapped) {
        throw new PlanValidationError(
          `${step.id}: ${id} on ${chain.key} must go between ${chain.nativeSymbol} and the wrapped token ${chain.wrappedNative.address}`
        );
      }
    },
    normalizeStep(step) {
      // The model may name the wrapped token by symbol; plans store it by contract address.
      const chain = getChain(step.chainFrom.toLowerCase());
      const wrapped = chain?.wrappedNative;
      if (!wrapped) return step;
      const fix = (token: string) => (token.toUpperCase() === wrapped.symbol.toUpperCase() ? wrapped.address : token);
      return { ...step, tokenIn: fix(step.tokenIn), tokenOut: fix(step.tokenOut) };
    },
    buildTx: async (step, amount) => built(step, amount, direction),
    run: (step, amount, account, onProgress) => run(direction, step, amount, account, onProgress),
    buildClient: async (step, amount, fromAddress): Promise<ClientStepBuild> => {
      const b = built(step, amount, direction);
      await simulate(step.chainFrom, b.tx, fromAddress);
      return { tx: b.tx, approvalTx: null, outputSymbol: b.outputSymbol, outputTokenAddress: null, outputDecimals: 18, resolvedAmountIn: amount };
    },
    confirmClient: (step, built_, txHash, receipt) => ({
      stepId: step.id,
      txHash,
      resolvedAmountIn: built_.resolvedAmountIn,
      actualAmountOut: built_.resolvedAmountIn,
      outputSymbol: built_.outputSymbol,
      gasUsed: receipt.gasUsed.toString(),
    }),
  };
}

export const wrapNative = make("wrap");
export const unwrapNative = make("unwrap");
