import { createPublicClient, createWalletClient, erc20Abi, encodeFunctionData, formatUnits, parseUnits } from "viem";
import type { Account } from "viem";
import type { PlanStep } from "../models.js";
import { VIEM_CHAIN, NATIVE_SYMBOL } from "../tokenRegistry.js";
import { alchemyHttp } from "../adapters/alchemyTransport.js";
import { resolveTokenReference, tokenReferenceDecimals } from "../tokenReference.js";
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
 * transfer: a plain same-chain send of the signer's own asset to a
 * third-party address — native value transfer or an ERC20 transfer() call,
 * whichever tokenIn calls for. Unlike swap/bridge/protocol_supply, there's
 * nothing to "measure" afterward (no exchange happened) — the amount
 * received by the recipient IS resolvedAmountIn by definition.
 */
async function runTransferStep(
  step: PlanStep,
  resolvedAmountIn: number,
  account: Account,
  onProgress?: ProgressCallback
): Promise<StepResult> {
  if (!step.transferTo) {
    throw new OrchestratorError("transfer step missing transferTo", step.id);
  }
  const isNative = step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom];
  const decimals = isNative ? 18 : await tokenReferenceDecimals(step.chainFrom, step.tokenIn);
  let amountBaseUnits = parseUnits(String(resolvedAmountIn), decimals);

  let tx: { to: `0x${string}`; data: `0x${string}`; value: bigint };
  if (isNative) {
    // A native-token transfer that asks for the wallet's full balance is
    // otherwise self-defeating — that same balance is what pays this
    // transaction's own gas. goalParser only reserves gas when the user
    // explicitly says to (e.g. "keep some for gas"); this is the
    // deterministic backstop that holds regardless of what the plan
    // literally says, same discipline as the targetChain/decimals backstops
    // elsewhere in this codebase. A generous (3x) buffer on top of a live
    // EIP-1559 fee estimate, not a legacy gasPrice snapshot — L2 fees like
    // Polygon's can spike within seconds, and a tight margin here previously
    // failed a real send with "gas required exceeds allowance".
    const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
    const balance = await publicClient.getBalance({ address: account.address });
    const maxFeePerGas = await publicClient
      .estimateFeesPerGas()
      .then((f) => f.maxFeePerGas)
      .catch(() => publicClient.getGasPrice());
    const gasReserve = maxFeePerGas * 21000n * 3n;
    if (amountBaseUnits > balance - gasReserve) {
      const clamped = balance - gasReserve;
      if (clamped <= 0n) {
        throw new OrchestratorError(
          `Not enough ${step.tokenIn} on ${step.chainFrom} to cover both this transfer and its own gas`,
          step.id
        );
      }
      amountBaseUnits = clamped;
      resolvedAmountIn = Number(formatUnits(amountBaseUnits, decimals));
    }
    tx = { to: step.transferTo as `0x${string}`, data: "0x", value: amountBaseUnits };
  } else {
    const tokenAddress = resolveTokenReference(step.chainFrom, step.tokenIn);
    if (!tokenAddress) throw new OrchestratorError(`No known address for ${step.tokenIn} on ${step.chainFrom}`, step.id);
    tx = {
      to: tokenAddress,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [step.transferTo as `0x${string}`, amountBaseUnits] }),
      value: 0n,
    };
  }

  console.log(`  [${step.id}] simulating transfer (eth_call)...`);
  onProgress?.({ type: "step_status", stepId: step.id, status: "simulating", detail: `Sending ${resolvedAmountIn} ${step.tokenIn} to ${step.transferTo}` });
  await simulate(step.chainFrom, { to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` }, account.address);
  console.log(`  [${step.id}] simulation OK, no revert`);

  const walletClient = walletClientFor(account, step.chainFrom);
  onProgress?.({ type: "step_status", stepId: step.id, status: "sending" });
  const txHash = await walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
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
    resolvedAmountIn,
    actualAmountOut: resolvedAmountIn,
    outputSymbol: step.tokenIn,
    gasUsed: receipt.gasUsed.toString(),
  };
}

async function buildClientTransfer(step: PlanStep, resolvedAmountIn: number, fromAddress: `0x${string}`): Promise<ClientStepBuild> {
if (!step.transferTo) throw new OrchestratorError("transfer step missing transferTo", step.id);
const isNative = step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom];
const decimals = isNative ? 18 : await tokenReferenceDecimals(step.chainFrom, step.tokenIn);
let amountBaseUnits = BigInt(Math.round(resolvedAmountIn * 10 ** decimals));
let finalResolvedAmountIn = resolvedAmountIn;
let tx: TxRequest;
if (isNative) {
  // Same gas-reserve safety clamp as orchestrator.ts's runTransferStep —
  // a full-balance native send would otherwise leave nothing to pay this
  // same transaction's own gas.
  const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  const balance = await publicClient.getBalance({ address: fromAddress });
  const maxFeePerGas = await publicClient
    .estimateFeesPerGas()
    .then((f) => f.maxFeePerGas)
    .catch(() => publicClient.getGasPrice());
  const gasReserve = maxFeePerGas * 21000n * 3n;
  if (amountBaseUnits > balance - gasReserve) {
    const clamped = balance - gasReserve;
    if (clamped <= 0n) {
      throw new OrchestratorError(`Not enough ${step.tokenIn} on ${step.chainFrom} to cover both this transfer and its own gas`, step.id);
    }
    amountBaseUnits = clamped;
    finalResolvedAmountIn = Number(formatUnits(amountBaseUnits, decimals));
  }
  tx = { to: step.transferTo as `0x${string}`, data: "0x", value: `0x${amountBaseUnits.toString(16)}` as `0x${string}` };
} else {
  const tokenAddress = resolveTokenReference(step.chainFrom, step.tokenIn);
  if (!tokenAddress) throw new OrchestratorError(`No known address for ${step.tokenIn} on ${step.chainFrom}`, step.id);
  tx = {
    to: tokenAddress,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [step.transferTo as `0x${string}`, amountBaseUnits] }),
    value: "0x0",
  };
}
await simulate(step.chainFrom, tx, fromAddress);
return { tx, approvalTx: null, outputSymbol: step.tokenIn, outputTokenAddress: null, outputDecimals: decimals, resolvedAmountIn: finalResolvedAmountIn };
}

export const transfer: Capability = {
  id: "transfer",
  label: "Transfer",
  summary: "Send a native token or ERC-20 to another address on the same chain.",
  availableOn: () => true,
  transferToRequired: true,
  promptRules: `- transfer is a plain same-chain send (native or ERC20) to a THIRD-PARTY address. Set
  chainFrom = chainTo, tokenIn = tokenOut (the asset being sent), and transferTo to the
  recipient address (required for transfer). To send to an address on a different chain,
  bridge first, then transfer on the destination chain — never set chainFrom != chainTo
  on a transfer step itself.`,
  describe: (s) => {
    const from = s.transferFrom ? `from ${s.transferFrom} ` : "";
    const dep = s.dependsOn.length ? ` (depends on: ${s.dependsOn.join(", ")})` : "";
    return `  [${s.id}] transfer: ${from}${s.amountIn} ${s.tokenIn} (${s.chainFrom}) -> ${s.transferTo}${dep}`;
  },
  validateStep(step, ctx) {
    if (step.chainFrom.toLowerCase() !== step.chainTo.toLowerCase()) {
      throw new PlanValidationError(`${step.id}: transfer must have chainFrom === chainTo — use bridge first, then transfer, for a cross-chain send`);
    }
    if (!step.transferTo || !/^0x[a-fA-F0-9]{40}$/.test(step.transferTo)) {
      throw new PlanValidationError(
        `${step.id}: transferTo "${step.transferTo ?? "null"}" is not a valid address. Use one of ${ctx.knownWalletLabels} or a 0x address.`
      );
    }
    if (step.tokenIn.toLowerCase() !== step.tokenOut.toLowerCase()) {
      throw new PlanValidationError(`${step.id}: transfer's tokenOut must equal tokenIn (it's the same asset, just sent to someone else)`);
    }
  },
  run: (step, resolvedAmountIn, account, onProgress) => runTransferStep(step, resolvedAmountIn, account, onProgress),
  buildClient: buildClientTransfer,
  confirmClient: (step, built, txHash, receipt) => {
    return {
      stepId: step.id,
      txHash,
      resolvedAmountIn: built.resolvedAmountIn,
      actualAmountOut: built.resolvedAmountIn,
      outputSymbol: built.outputSymbol,
      gasUsed: receipt.gasUsed.toString(),
    };
  },
};
