/**
 * Execution primitives shared by the orchestrator, the browser-signer client
 * path and every capability module (see ../capabilities/). Kept in its own
 * file so capability modules never import orchestrator.ts: the orchestrator
 * dispatches to capabilities, and a capability importing the orchestrator back
 * would create a circular dependency.
 */
import { createPublicClient, createWalletClient, parseEventLogs, erc20Abi, maxUint256 } from "viem";
import type { Account, JsonRpcAccount, Transport } from "viem";
import { VIEM_CHAIN } from "../tokenRegistry.js";
import { alchemyHttp } from "../adapters/alchemyTransport.js";

/**
 * An account whose transactions are signed and broadcast by an external service (for example a TEE wallet)
 * rather than by a key held here. It supplies the transport that carries eth_sendTransaction.
 */
export type ExternalSignerAccount = JsonRpcAccount & { transportFor(chainKey: string): Transport };

/** A wallet client for a signer's account: local keys sign here, external signers send through their own transport. */
export function walletClientFor(account: Account, chainKey: string) {
  const external = (account as Partial<ExternalSignerAccount>).transportFor;
  return createWalletClient({ account, chain: VIEM_CHAIN[chainKey], transport: external ? external.call(account, chainKey) : alchemyHttp(chainKey) });
}

export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
    /** Present only after a transaction was actually broadcast. Callers can
     * distinguish a pre-send error from an on-chain failure and retain proof. */
    public readonly txHash?: `0x${string}`
  ) {
    super(message);
  }
}

export interface StepResult {
  stepId: string;
  txHash: `0x${string}`;
  destTxHash?: `0x${string}`; // cross-chain steps only — the destination-chain delivery tx (a separate tx submitted by the bridge's own relayer, not signed by us)
  resolvedAmountIn: number;
  actualAmountOut: number;
  outputSymbol: string; // what was actually measured (may be an aToken symbol for deposits)
  gasUsed: string; // decimal string (bigint doesn't survive JSON.stringify) — for execution-log display
  /** Set by deploy_contract: later steps reach the new contract as deployed_by(<step id>). */
  deployedContract?: { chain: string; address: `0x${string}`; name: string; source: string; abi: unknown[] };
}

/**
 * Real-time progress events emitted while a plan runs — lets a caller (e.g.
 * server.ts's SSE endpoint) show live per-step status instead of a single
 * blocking "executing..." spinner until the whole plan finishes. Every field
 * is real data pulled from the same values already being sent/measured, not
 * synthesized for display.
 */
export type ProgressEvent =
  | { type: "step_start"; stepId: string; action: string; summary: string }
  | { type: "step_status"; stepId: string; status: string; detail?: string }
  | { type: "step_tx"; stepId: string; label: "source" | "destination" | "approval"; chainKey: string; txHash: string }
  | { type: "step_complete"; stepId: string; result: StepResult }
  | { type: "step_failed"; stepId: string; error: string };

export type ProgressCallback = (event: ProgressEvent) => void;

export interface TxRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
}

export interface BuiltStep {
  tx: TxRequest;
  outputSymbol: string;
  outputTokenAddress: `0x${string}` | null; // null means native token output (not yet supported for measurement — see readActualOutput)
  outputDecimals: number;
  bridgeAdapter?: "lifi" | "relay"; // only set for swap/bridge/cross_chain_swap steps
  /** The route provider that built this step (relay, lifi, enso, okx ...), recorded with its outcome. */
  provider?: string;
  relayRequestId?: string; // only set when bridgeAdapter === "relay"
  /** A same-chain DEX can expose a dedicated ERC-20 approval target that is
   * different from the router transaction's `to` address. */
  approvalSpender?: `0x${string}`;
}

/**
 * Gas limit with headroom for routed swap/bridge and custom-call transactions. A bare eth_estimateGas can be
 * too tight for contracts whose behaviour depends on remaining gas (verified: a Relay bridge on X Layer ran
 * out of gas with 665k used of a 665k limit while simulating fine). Unused gas is refunded, so the headroom
 * costs nothing. GAS_LIMIT_BUFFER_PCT (default 30) tunes it; undefined lets the wallet client estimate itself.
 */
export async function gasLimitWithHeadroom(chainKey: string, from: `0x${string}`, tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }): Promise<bigint | undefined> {
  try {
    const pct = BigInt(Math.max(0, Math.round(Number(process.env.GAS_LIMIT_BUFFER_PCT ?? 30))));
    const client = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
    const estimate = await client.estimateGas({ account: from, to: tx.to, data: tx.data, value: tx.value });
    return (estimate * (100n + pct)) / 100n;
  } catch {
    return undefined;
  }
}

export async function simulate(chainKey: string, tx: TxRequest, fromAddress: `0x${string}`): Promise<void> {
  const client = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  await client.call({ account: fromAddress, to: tx.to, data: tx.data, value: BigInt(tx.value) });
}

/** Server-signed wallets may send several confirmed transactions in one plan.
 * Always allocate from the node's pending nonce, rather than relying on a
 * wallet SDK's stale local nonce snapshot after the preceding confirmation. */
export async function pendingNonce(chainKey: string, address: `0x${string}`): Promise<number> {
  const client = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  return client.getTransactionCount({ address, blockTag: "pending" });
}

/**
 * ERC20 inputs need the router contract approved to pull them via
 * transferFrom before the actual swap/deposit tx can succeed — this isn't
 * optional, it's how ERC20 allowances work. Checks current allowance first
 * and only sends an approve() transaction if it's actually insufficient
 * (skips it on repeat calls to the same spender). Simulated before sending,
 * same as every other transaction this orchestrator sends.
 */
export async function ensureAllowance(
  chainKey: string,
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amountNeededBaseUnits: bigint,
  account: Account,
  stepId: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const publicClient = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  const current = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (current >= amountNeededBaseUnits) return;

  console.log(`  approving ${spender} to spend ${tokenAddress} (current allowance insufficient)...`);
  onProgress?.({ type: "step_status", stepId, status: "approving", detail: `Approving ${spender} to spend ${tokenAddress}` });
  const { request } = await publicClient.simulateContract({
    account,
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  const walletClient = walletClientFor(account, chainKey);
  const approveHash = await walletClient.writeContract({ ...request, nonce: await pendingNonce(chainKey, account.address) });
  console.log(`  approval tx: ${approveHash} — waiting for confirmation...`);
  onProgress?.({ type: "step_tx", stepId, label: "approval", chainKey, txHash: approveHash });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  if (receipt.status !== "success") {
    throw new Error(`Approval transaction ${approveHash} reverted on-chain`);
  }
  // A receipt can be available a fraction before the RPC node serving the
  // following eth_call has incorporated its state transition. Do not run the
  // dependent router simulation against that stale state; wait until the
  // allowance itself is observable from the same Alchemy-backed client.
  for (let attempt = 0; attempt < 10; attempt++) {
    const observed = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender],
    });
    if (observed >= amountNeededBaseUnits) {
      console.log(`  approval confirmed in block ${receipt.blockNumber}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Approval ${approveHash} confirmed but its allowance is not yet visible through ${chainKey} RPC`);
}

/**
 * Reads how much of outputTokenAddress this specific transaction transferred
 * to `recipient`, by decoding the Transfer logs in its own receipt — not by
 * polling balance before/after (see the file-level comment for why).
 */
export function readActualOutputFromReceipt(
  receiptLogs: Parameters<typeof parseEventLogs>[0]["logs"],
  outputTokenAddress: `0x${string}`,
  recipient: `0x${string}`,
  decimals: number
): number {
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receiptLogs,
  });
  const toUs = transfers.filter(
    (t) => t.address.toLowerCase() === outputTokenAddress.toLowerCase() && t.args.to.toLowerCase() === recipient.toLowerCase()
  );
  const total = toUs.reduce((sum, t) => sum + t.args.value, 0n);
  return Number(total) / 10 ** decimals;
}

/** One browser-signed step: the unsigned transactions the frontend must sign, plus how its output is measured. */
export interface ClientStepBuild {
  tx: TxRequest;
  approvalTx: TxRequest | null;
  outputSymbol: string;
  outputTokenAddress: `0x${string}` | null;
  outputDecimals: number;
  bridgeAdapter?: "lifi" | "relay";
  relayRequestId?: string;
  resolvedAmountIn: number;
}
