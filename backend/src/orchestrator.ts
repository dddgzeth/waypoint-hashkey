/**
 * Orchestrator: the real execution-time state machine. Takes a validated
 * ExecutionPlan and actually runs it — signs and broadcasts a real
 * transaction for each step, on real mainnet chains, with real funds.
 *
 * Safety rules:
 *   1. Every step is simulated (eth_call) before it is ever signed. A step
 *      that would revert is never sent.
 *      (There is deliberately no platform-wide dollar cap on step size — a
 *      hardcoded limit is a decision for whoever owns the funds, not for
 *      this codebase to impose on their behalf. If a spending limit is
 *      wanted, it belongs as a user-set, per-account/per-wallet setting —
 *      not baked in here.)
 *   2. Steps run strictly in order (step1, step2, ...). If any step's
 *      simulation OR real execution fails, the run stops immediately —
 *      dependent steps are never attempted on top of a failed/uncertain
 *      state.
 *   3. `output_of(stepX)` references are resolved from the REAL measured
 *      output of that step, and the measurement method depends on whether
 *      the step is same-chain or cross-chain:
 *        - Same-chain: parsed directly from the ERC20 Transfer log(s) in
 *          that step's own transaction receipt. (An earlier version polled
 *          balance before/after via separate RPC calls and got a false
 *          "0 received" on a real, successful swap — the "after" read hit a
 *          public RPC node that hadn't caught up yet. Reading the receipt's
 *          own logs is deterministic: it reflects exactly what that
 *          transaction did, independent of any other node's state.)
 *        - Cross-chain (bridge / cross_chain_swap): the destination-chain
 *          delivery is a SEPARATE transaction submitted by the bridge's own
 *          relayer/solver, not something we sign — it cannot appear in our
 *          source-chain transaction's receipt. Confirmed via the bridge's own
 *          status-tracking endpoint (LI.FI's /status polled by source tx
 *          hash, or Relay's /intents/status/v3 polled by requestId) until it
 *          reports delivery is done — that's what the bridge protocol itself
 *          reports as delivered, rather than us guessing at destination
 *          balance changes that could collide with unrelated activity. For
 *          Relay specifically, the status endpoint's own "done" payload
 *          shape wasn't fully documented, so once it confirms delivery we
 *          still read the actual amount from the destination tx's own
 *          Transfer log (same technique as the same-chain case, just against
 *          the destination chain's receipt instead of the source chain's).
 *   4. Two bridge vendors are wired up (LI.FI and Relay); a plan step picks
 *      one via its `vendorAdapter` field; when unset, Relay is tried first
 *      and LI.FI is the fallback (BRIDGE_PRIMARY=lifi flips the order).
 *      Neither is a hard dependency — see plan.md for why.
 */
import { createPublicClient, createWalletClient, parseEventLogs, erc20Abi, maxUint256, encodeFunctionData, formatUnits, parseUnits } from "viem";
import type { Account } from "viem";
import type { ExecutionPlan, PlanStep } from "./models.js";
import { VIEM_CHAIN, NATIVE_SYMBOL, NATIVE_PLACEHOLDER_EEEE } from "./tokenRegistry.js";
import { getChain } from "./chains/index.js";
import { alchemyHttp, alchemyHttpForKey } from "./adapters/alchemyTransport.js";
import { getSingleTokenBalance } from "./stateReader.js";
import { getLifiQuote, pollLifiStatus } from "./adapters/lifi.js";
import { getRelayQuote, pollRelayStatus } from "./adapters/relay.js";
import { getAaveBorrowMarket, getAaveSupplyApy } from "./adapters/aaveYield.js";
import { getHealthFactor } from "./adapters/aaveHealthFactor.js";
import { getEnsoRoute } from "./adapters/enso.js";
import { getOkxDexSwapRoute } from "./adapters/okxDex.js";
import { encodeCustomCall } from "./customCall/execute.js";
import { resolveTokenReference, tokenReferenceDecimals } from "./tokenReference.js";
import { resolveLiveProtocolTokenReferences } from "./protocolTokenResolver.js";
import { alchemyApiKeys } from "./chains/index.js";
import {
  OrchestratorError,
  simulate,
  pendingNonce,
  gasLimitWithHeadroom,
  ensureAllowance,
  readActualOutputFromReceipt,
  type StepResult,
  type ProgressEvent,
  type ProgressCallback,
  type TxRequest,
  type BuiltStep, walletClientFor } from "./execution/shared.js";
import { getCapability } from "./capabilities/index.js";
import { getMemory } from "./memory/index.js";
import { isRouteFault } from "./memory/routeFault.js";

// These used to be declared here; other modules still import them from the orchestrator.
export { OrchestratorError, simulate, readActualOutputFromReceipt };
export type { StepResult, ProgressEvent, ProgressCallback, TxRequest };







const OUTPUT_OF_RE = /^output_of\(([^)]+)\)$/;
const DEPLOYED_BY_RE = /^deployed_by\(([^)]+)\)$/;

/** Replaces deployed_by(<step id>) in a step's address fields with the contract that step deployed. */
function bindDeployedAddresses(step: PlanStep, results: Map<string, StepResult>): PlanStep {
  const bind = (value: string | null): string | null => {
    const match = value ? DEPLOYED_BY_RE.exec(value) : null;
    if (!match) return value;
    const address = results.get(match[1])?.deployedContract?.address;
    if (!address) throw new OrchestratorError(`${value} refers to a step that did not deploy a contract`, step.id);
    return address;
  };
  return { ...step, customCallTarget: bind(step.customCallTarget), transferTo: bind(step.transferTo) };
}

async function resolveAmountIn(step: PlanStep, results: Map<string, StepResult>, account: Account): Promise<number> {
  if (step.amountIn === "all") {
    if (step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom]) {
      throw new OrchestratorError('amountIn "all" is only supported for ERC20 balances; native assets must reserve gas', step.id);
    }
    const resolveAll = getCapability(step.action)?.resolveAllAmount;
    if (resolveAll) return resolveAll(step, account);
    const amount = await getSingleTokenBalance(step.chainFrom, step.tokenIn, account.address);
    if (amount <= 0) throw new OrchestratorError(`No ${step.tokenIn} balance is available for amountIn "all"`, step.id);
    return amount;
  }
  const match = OUTPUT_OF_RE.exec(step.amountIn);
  if (!match) {
    const n = Number(step.amountIn);
    if (Number.isNaN(n)) throw new OrchestratorError(`amountIn is not a number or output_of() reference: ${step.amountIn}`, step.id);
    return n;
  }
  const refId = match[1];
  const refResult = results.get(refId);
  if (!refResult) throw new OrchestratorError(`amountIn references ${refId}, which hasn't executed yet`, step.id);
  return refResult.actualAmountOut;
}

/** Builds the real transaction for a step through the capability that owns its action. */
/**
 * recipientAddress: where this step's output should land, if different from
 * fromAddress (the wallet that signs/funds it) — e.g. consolidating several
 * execution wallets' assets into one before a deposit. Defaults to
 * fromAddress (the pre-existing behavior: output returns to the signer).
 */
export async function buildStepTx(
  step: PlanStep,
  resolvedAmountIn: number,
  fromAddress: `0x${string}`,
  recipientAddress: `0x${string}` = fromAddress
): Promise<BuiltStep> {
  const capability = getCapability(step.action);
  if (!capability?.buildTx) {
    throw new OrchestratorError(`No transaction builder is registered for action "${step.action}"`, step.id);
  }
  return capability.buildTx(step, resolvedAmountIn, fromAddress, recipientAddress);
}




/** A receipt and an immediately following eth_call can briefly observe
 * different state snapshots on an RPC. Before a later plan step spends the
 * just-produced output, wait until that output is observable through the
 * same Alchemy-backed read path. */
async function waitForOutputVisibility(step: PlanStep, result: StepResult, recipient: `0x${string}`): Promise<void> {
  if (result.actualAmountOut <= 0) return;
  const clients = alchemyApiKeys().map((_, index) =>
    createPublicClient({ chain: VIEM_CHAIN[step.chainTo], transport: alchemyHttpForKey(step.chainTo, index) })
  );

  // LI.FI/Relay confirms delivery from its own status service. Before a
  // dependent destination-chain action, also require every configured
  // Alchemy endpoint to see the successful destination receipt. A single
  // stale endpoint returning a valid old balance is not an RPC error, so a
  // fallback transport cannot detect or correct it by itself.
  if (step.chainFrom !== step.chainTo && result.destTxHash) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const receipts = await Promise.all(
        clients.map((client) => client.getTransactionReceipt({ hash: result.destTxHash! }).catch(() => null))
      );
      if (receipts.every((receipt) => receipt?.status === "success")) break;
      if (attempt === 59) {
        throw new OrchestratorError(
          `${step.id}: destination transaction ${result.destTxHash} is confirmed by the bridge but not yet visible on every ${step.chainTo} Alchemy endpoint`,
          step.id,
          result.txHash
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  // Some actions (an Aave supply) produce a receipt token only visible through a protocol read.
  if (await getCapability(step.action)?.awaitOutputVisible?.(step, result, recipient, clients)) return;
  const expected = result.actualAmountOut;
  // outputSymbol is presentation metadata (for example "USDC"). The plan's
  // tokenOut is the canonical contract identifier resolved from live chain
  // state; visibility checks must never try to execute from a display label.
  const isNative = step.tokenOut.toUpperCase() === NATIVE_SYMBOL[step.chainTo];
  const tokenAddress = isNative ? null : resolveTokenReference(step.chainTo, step.tokenOut);
  const decimals = isNative ? 18 : await tokenReferenceDecimals(step.chainTo, step.tokenOut);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const balances = await Promise.all(clients.map(async (client) => {
        if (isNative) return Number(formatUnits(await client.getBalance({ address: recipient }), 18));
        const raw = await client.readContract({ address: tokenAddress!, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
        return Number(formatUnits(raw, decimals));
      }));
      if (balances.every((balance) => balance + 1e-12 >= expected)) return;
    } catch {
      // An unknown output token has no generic balance reader. Its own
      // dependent adapter will still simulate before it can be spent.
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new OrchestratorError(
    `${step.id}: ${result.outputSymbol} output is confirmed but not yet visible through ${step.chainTo} RPC`,
    step.id
  );
}



async function runStep(step: PlanStep, resolvedAmountIn: number, account: Account, onProgress?: ProgressCallback): Promise<StepResult> {
  // The plan can name a specific source wallet for ANY step (a real bug this
  // originally caught for transfer steps: the confirm UI let you pick ANY
  // execution wallet to "run from" regardless of which wallet the plan
  // actually named as the source — silently executing from the wrong
  // wallet's balance instead of refusing). This is the deterministic
  // backstop that holds even if a caller (runPlan's per-step signer
  // resolution, or a caller bypassing it) gets the wrong account here.
  if (step.transferFrom && step.transferFrom.toLowerCase() !== account.address.toLowerCase()) {
    throw new OrchestratorError(
      `${step.id}: this step's source is ${step.transferFrom}, but execution was requested from ${account.address} — refusing to run a step from the wrong wallet`,
      step.id
    );
  }
  const capability = getCapability(step.action);
  if (!capability) throw new OrchestratorError(`Unknown action "${step.action}"`, step.id);
  if (capability.run) return capability.run(step, resolvedAmountIn, account, onProgress);

  const isCrossChain = step.chainFrom !== step.chainTo;

  // For a non-transfer step, transferTo optionally redirects the output to a
  // different wallet than the one signing this step (e.g. consolidating
  // several execution wallets into one before a deposit) — see models.ts's
  // doc comment on transferTo. Defaults to the signer's own address, the
  // pre-existing behavior.
  const recipient = (step.transferTo?.toLowerCase() as `0x${string}` | undefined) ?? account.address;

  onProgress?.({ type: "step_status", stepId: step.id, status: "quoting", detail: `Getting a route for ${step.action}` });
  let built = await buildStepTx(step, resolvedAmountIn, account.address, recipient);
  const startedAt = Date.now();
  const provider = built.provider ?? step.protocol?.toLowerCase();
  const record = (success: boolean, error?: unknown) => {
    if (!provider || (!success && !isRouteFault(error))) return;
    try {
      getMemory().recordOutcome({ provider, action: step.action, chainFrom: step.chainFrom, chainTo: step.chainTo, success, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : error ? String(error) : undefined });
    } catch (err) {
      console.error("[outcomes] could not record:", err instanceof Error ? err.message : err);
    }
  };
  try {
  // Native outputs do not emit an ERC20 Transfer log. Measure the recipient's
  // balance delta on the destination chain instead, adding back the transaction
  // fee for a same-chain step whose recipient is also the signer (a cross-chain
  // step's fee is paid on the source chain, so the destination delta is exact).
  // This keeps output_of() accurate without pretending a native transfer has a log.
  const nativeOutputClient =
    built.outputTokenAddress === null
      ? createPublicClient({ chain: VIEM_CHAIN[step.chainTo], transport: alchemyHttp(step.chainTo) })
      : null;
  const nativeOutputBefore = nativeOutputClient ? await nativeOutputClient.getBalance({ address: recipient }) : null;

  const isNativeIn = step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom];
  let inputApproval: { tokenAddress: `0x${string}`; amountNeeded: bigint } | null = null;
  if (!isNativeIn && capability.approvesInput !== false) {
    const tokenInAddress = resolveTokenReference(step.chainFrom, step.tokenIn);
    if (!tokenInAddress) {
      throw new OrchestratorError(`No known address for input token ${step.tokenIn} on ${step.chainFrom}`, step.id);
    }
    const decimals = await tokenReferenceDecimals(step.chainFrom, step.tokenIn);
    const amountNeeded = parseUnits(String(resolvedAmountIn), decimals);
    inputApproval = { tokenAddress: tokenInAddress, amountNeeded };
    await ensureAllowance(step.chainFrom, tokenInAddress, built.approvalSpender ?? built.tx.to, amountNeeded, account, step.id, onProgress);
  }

  // A routed swap can contain an expiry/minimum-output constraint. Approval
  // confirmation may take a block or two, so never send the quote we fetched
  // before that wait: request a fresh route and simulate that exact payload
  // immediately before signing.
  if (capability.refreshQuoteBeforeSend) {
    built = await buildStepTx(step, resolvedAmountIn, account.address, recipient);
    // A freshly quoted route may use a different router/allowance target. The
    // first call is usually a no-op; this second check guarantees the exact
    // calldata about to be simulated has its required allowance.
    if (inputApproval) {
      await ensureAllowance(
        step.chainFrom,
        inputApproval.tokenAddress,
        built.approvalSpender ?? built.tx.to,
        inputApproval.amountNeeded,
        account,
        step.id,
        onProgress
      );
    }
  }

  console.log(`  [${step.id}] simulating (eth_call)...`);
  onProgress?.({ type: "step_status", stepId: step.id, status: "simulating" });
  await simulate(step.chainFrom, built.tx, account.address);
  console.log(`  [${step.id}] simulation OK, no revert`);

  const walletClient = walletClientFor(account, step.chainFrom);
  console.log(`  [${step.id}] sending real transaction on ${step.chainFrom}...`);
  onProgress?.({ type: "step_status", stepId: step.id, status: "sending" });
  const txHash = await walletClient.sendTransaction({
    to: built.tx.to,
    data: built.tx.data,
    value: BigInt(built.tx.value),
    gas: await gasLimitWithHeadroom(step.chainFrom, account.address, { to: built.tx.to, data: built.tx.data, value: BigInt(built.tx.value) }),
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

  let actualAmountOut: number;
  let destTxHash: `0x${string}` | undefined;
  if (isCrossChain) {
    if (built.bridgeAdapter === "relay") {
      console.log(`  [${step.id}] cross-chain step (Relay) — polling /intents/status/v3 for destination-chain delivery...`);
      onProgress?.({ type: "step_status", stepId: step.id, status: "bridging", detail: "Polling Relay for destination-chain delivery" });
      const status = await pollRelayStatus({ requestId: built.relayRequestId! });
      if (status.status !== "DONE" || !status.receivingTxHash) {
        throw new OrchestratorError(
          `Cross-chain delivery did not complete via Relay (status=${status.rawStatus}) — source tx ${txHash} succeeded but funds have not arrived on ${step.chainTo}`,
          step.id
        );
      }
      console.log(`  [${step.id}] destination delivery confirmed: tx ${status.receivingTxHash} on ${step.chainTo}`);
      destTxHash = status.receivingTxHash;
      onProgress?.({ type: "step_tx", stepId: step.id, label: "destination", chainKey: step.chainTo, txHash: status.receivingTxHash });
      if (built.outputTokenAddress) {
        const destClient = createPublicClient({ chain: VIEM_CHAIN[step.chainTo], transport: alchemyHttp(step.chainTo) });
        const destReceipt = await destClient.getTransactionReceipt({ hash: status.receivingTxHash });
        actualAmountOut = readActualOutputFromReceipt(destReceipt.logs, built.outputTokenAddress, recipient, built.outputDecimals);
      } else {
        // Pin both reads to the delivery transaction's block: a "latest" read can come from an endpoint that
        // hasn't seen the delivery yet (observed on Base: it reported 0 for a delivery that had landed).
        const destReceipt = await nativeOutputClient!.waitForTransactionReceipt({ hash: status.receivingTxHash, timeout: 120_000 });
        const [atBlock, beforeBlock] = await Promise.all([
          nativeOutputClient!.getBalance({ address: recipient, blockNumber: destReceipt.blockNumber }),
          nativeOutputClient!.getBalance({ address: recipient, blockNumber: destReceipt.blockNumber - 1n }),
        ]);
        const received = atBlock - beforeBlock;
        actualAmountOut = Number(formatUnits(received > 0n ? received : 0n, built.outputDecimals));
      }
    } else {
      console.log(`  [${step.id}] cross-chain step (LI.FI) — polling /status for destination-chain delivery...`);
      onProgress?.({ type: "step_status", stepId: step.id, status: "bridging", detail: "Polling LI.FI for destination-chain delivery" });
      const status = await pollLifiStatus({
        sourceTxHash: txHash,
        fromChain: step.chainFrom,
        toChain: step.chainTo,
        toTokenDecimals: built.outputDecimals,
      });
      if (status.status !== "DONE" || status.receivedAmount === null) {
        throw new OrchestratorError(
          `Cross-chain delivery did not complete (status=${status.status}, substatus=${status.substatus}) — source tx ${txHash} succeeded but funds have not arrived on ${step.chainTo}`,
          step.id
        );
      }
      console.log(`  [${step.id}] destination delivery confirmed: tx ${status.receivingTxHash} on ${step.chainTo}`);
      if (status.receivingTxHash) {
        destTxHash = status.receivingTxHash;
        onProgress?.({ type: "step_tx", stepId: step.id, label: "destination", chainKey: step.chainTo, txHash: status.receivingTxHash });
      }
      actualAmountOut = status.receivedAmount;
    }
  } else {
    if (built.outputTokenAddress) {
      actualAmountOut = readActualOutputFromReceipt(receipt.logs, built.outputTokenAddress, recipient, built.outputDecimals);
    } else {
      const after = await nativeOutputClient!.getBalance({ address: recipient });
      const gasPaid = recipient.toLowerCase() === account.address.toLowerCase() ? receipt.gasUsed * receipt.effectiveGasPrice : 0n;
      const received = after - nativeOutputBefore! + gasPaid;
      actualAmountOut = Number(formatUnits(received > 0n ? received : 0n, built.outputDecimals));
    }
  }

  record(true);
  return {
    stepId: step.id,
    txHash,
    destTxHash,
    resolvedAmountIn,
    actualAmountOut,
    outputSymbol: built.outputSymbol,
    gasUsed: receipt.gasUsed.toString(),
  };
  } catch (err) {
    record(false, err);
    throw err;
  }
}

/**
 * Runs every step of a validated plan in order, stopping immediately on the
 * first failure. `onProgress`, if given, receives real-time events as each
 * step moves through simulate/send/confirm/measure — the same data that
 * ends up in the final StepResult, just surfaced as it happens instead of
 * only after the whole plan finishes.
 *
 * `resolveAccount`, if given, looks up the real signer for a step that names
 * a specific source wallet (step.transferFrom) OTHER than `account` — e.g. a
 * goal spanning several of the caller's own execution wallets ("consolidate
 * execution wallet 1, 2, and 3, then deposit into Aave") in ONE confirmed
 * plan, each step signed by whichever wallet it actually names, instead of
 * forcing that into several separate single-wallet plans. Every wallet this
 * can resolve to must itself be one this backend genuinely holds a key for
 * (an execution wallet) — the caller (server.ts) is what enforces that
 * scope, this function just uses whatever it's given. Without resolveAccount
 * (or when a step names no source), every step runs as `account` — the
 * pre-existing single-signer behavior, unchanged.
 */
export async function runPlan(
  plan: ExecutionPlan,
  account: Account,
  onProgress?: ProgressCallback,
  resolveAccount?: (address: string) => Promise<Account>
): Promise<StepResult[]> {
  // Resolve destination protocol assets from live chain state again at
  // execution time. A saved plan may be older than the current protocol
  // registry, and a new wallet need not already hold the destination token.
  const executablePlan = await resolveLiveProtocolTokenReferences(plan);
  const results = new Map<string, StepResult>();
  const ordered: StepResult[] = [];

  for (const plannedStep of executablePlan.steps) {
    const step = bindDeployedAddresses(plannedStep, results);
    const signerAccount =
      step.transferFrom && step.transferFrom.toLowerCase() !== account.address.toLowerCase() && resolveAccount
        ? await resolveAccount(step.transferFrom)
        : account;
    const resolvedAmountIn = await resolveAmountIn(step, results, signerAccount);
    console.log(`\n=== Executing ${step.id}: ${step.action} ${resolvedAmountIn} ${step.tokenIn} (${step.chainFrom}) -> ${step.tokenOut} (${step.chainTo}) [signer: ${signerAccount.address}] ===`);
    onProgress?.({
      type: "step_start",
      stepId: step.id,
      action: step.action,
      summary: `${step.action} ${resolvedAmountIn} ${step.tokenIn} (${step.chainFrom}) -> ${step.tokenOut} (${step.chainTo})`,
    });
    try {
      const result = await runStep(step, resolvedAmountIn, signerAccount, onProgress);
      const recipient = (step.transferTo?.toLowerCase() as `0x${string}` | undefined) ?? signerAccount.address;
      await waitForOutputVisibility(step, result, recipient);
      results.set(step.id, result);
      ordered.push(result);
      console.log(`  [${step.id}] done — received ${result.actualAmountOut} ${result.outputSymbol}`);
      onProgress?.({ type: "step_complete", stepId: step.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ type: "step_failed", stepId: step.id, error: message });
      throw err;
    }
  }

  return ordered;
}
