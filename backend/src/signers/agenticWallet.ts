/**
 * OKX Agentic Wallet signer. The wallet's key lives in OKX's TEE and is never
 * exportable, so Waypoint cannot sign: it hands each transaction to the logged-in
 * `onchainos` CLI, which signs and broadcasts it inside the enclave and returns
 * the transaction hash. The orchestrator still simulates every step, waits for
 * the receipt and measures the real output exactly as for any other signer.
 *
 * The CLI has to be logged in on the machine running the backend
 * (`onchainos wallet status`). It can send transfers and contract calls; it
 * cannot deploy a contract.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { custom, type Transport } from "viem";
import { getChain } from "../chains/index.js";
import { alchemyHttp } from "../adapters/alchemyTransport.js";
import type { ExternalSignerAccount } from "../execution/shared.js";
import type { Signer } from "./types.js";

const run = promisify(execFile);
const BIN = () => process.env.ONCHAINOS_BIN || "onchainos";

async function cli(args: string[]): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    ({ stdout } = await run(BIN(), args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (err) {
    // The CLI reports failures as JSON on stdout with a non-zero exit code.
    const out = (err as { stdout?: string }).stdout;
    if (!out) throw new Error(`onchainos is not available: ${err instanceof Error ? err.message : String(err)}`);
    stdout = out;
  }
  const parsed = JSON.parse(stdout) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  if (!parsed.ok) throw new Error(`OKX Agentic Wallet: ${parsed.error ?? "the request failed"}`);
  return parsed.data ?? {};
}

/** The EVM address of the logged-in Agentic Wallet account (the same on every EVM chain). */
export async function agenticWalletAddress(): Promise<`0x${string}`> {
  const status = await cli(["wallet", "status"]);
  if (!status.loggedIn) throw new Error("The OKX Agentic Wallet CLI is not logged in. Run `onchainos wallet login` on this machine first.");
  const addresses = (await cli(["wallet", "addresses"])) as { evm?: Array<{ address: string }> };
  const address = addresses.evm?.[0]?.address;
  if (!address) throw new Error("The OKX Agentic Wallet account has no EVM address");
  return address as `0x${string}`;
}

interface RpcTx {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
}

/** Signs and broadcasts one transaction inside the enclave; returns its hash. */
async function broadcast(chainKey: string, address: string, tx: RpcTx): Promise<`0x${string}`> {
  const chain = getChain(chainKey);
  if (!chain) throw new Error(`Unknown chain ${chainKey}`);
  if (!tx.to) throw new Error("The OKX Agentic Wallet can't deploy a contract: its CLI only sends transfers and contract calls.");
  const value = BigInt(tx.value ?? "0x0").toString();
  const hasData = Boolean(tx.data && tx.data !== "0x");
  const args = hasData
    ? ["wallet", "contract-call", "--chain", String(chain.chainId), "--to", tx.to, "--input-data", tx.data!, "--amt", value, "--from", address]
    : ["wallet", "send", "--chain", String(chain.chainId), "--recipient", tx.to, "--amt", value, "--from", address];
  if (hasData && tx.gas) args.push("--gas-limit", BigInt(tx.gas).toString());
  const result = await cli(args);
  const hash = (result.txHash ?? result.hash) as string | undefined;
  if (!hash) throw new Error("OKX Agentic Wallet accepted the transaction but returned no transaction hash");
  return hash as `0x${string}`;
}

/** Reads go to the normal RPC; only eth_sendTransaction is handed to the enclave. */
function transportFor(address: string, chainKey: string): Transport {
  const reads = alchemyHttp(chainKey);
  return (opts) => {
    const base = reads(opts);
    return custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_sendTransaction") return broadcast(chainKey, address, (params as RpcTx[])[0]);
        return base.request({ method, params } as never);
      },
    })(opts);
  };
}

export function agenticAccount(address: `0x${string}`): ExternalSignerAccount {
  return { address, type: "json-rpc", transportFor: (chainKey) => transportFor(address, chainKey) };
}

export const agenticWalletSigner: Signer = {
  id: "agentic",
  label: "OKX Agentic Wallet",
  kind: "tee",
  canExport: false,
  available: async () => {
    try {
      await agenticWalletAddress();
      return true;
    } catch {
      return false;
    }
  },
  account: (wallet) => agenticAccount(wallet.address as `0x${string}`),
};
