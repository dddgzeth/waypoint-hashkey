#!/usr/bin/env tsx
/**
 * Deploys WaypointStrategyLog from one of the account's execution wallets (signed through its own signer, e.g. Privy),
 * for when the standalone deploy wallet in secrets/ has no HSK. Same output as deploy.ts: deployed.json.
 * Dry run by default; --execute broadcasts.
 *   npx tsx src/hashkey/deployWithExecutionWallet.ts <accountId> <walletId> [--execute]
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeDeployData, formatEther, http } from "viem";
import { hashkey } from "../chains/hashkey.js";
import { compileSolidity } from "../contracts/compiler.js";
import { lintSolidity } from "../contracts/lint.js";
import { walletClientFor, pendingNonce } from "../execution/shared.js";
import { accountForWallet } from "../signers/index.js";
import { getExecutionWalletById } from "../wallets/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const [accountId, walletId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const execute = process.argv.includes("--execute");
if (!accountId || !walletId) throw new Error("usage: deployWithExecutionWallet.ts <accountId> <walletId> [--execute]");

const source = readFileSync(join(here, "WaypointStrategyLog.sol"), "utf8");
const issues = lintSolidity(source);
if (issues.length) throw new Error(`Lint failed: ${issues.map((i) => i.message).join("; ")}`);
const compiled = compileSolidity(source, "WaypointStrategyLog");
const data = encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode });

const wallet = getExecutionWalletById(accountId, walletId);
if (!wallet) throw new Error("No such execution wallet on this account");
const account = accountForWallet(wallet);
const client = createPublicClient({ chain: hashkey.viemChain, transport: http(hashkey.publicRpc) });

const balance = await client.getBalance({ address: account.address });
await client.call({ account: account.address, data });
const gas = await client.estimateGas({ account: account.address, data });
const gasPrice = await client.getGasPrice();
console.log(`deployer ${account.address} balance ${formatEther(balance)} HSK`);
console.log(`bytecode ${(compiled.bytecode.length - 2) / 2} bytes, gas ${gas}, cost ~${formatEther(gas * gasPrice)} HSK`);
if (!execute) {
  console.log("dry run OK. Re-run with --execute to deploy.");
  process.exit(0);
}
if (balance < gas * gasPrice * 3n) throw new Error("Not enough HSK to deploy");

const hash = await walletClientFor(account, "hashkey").sendTransaction({ data, gas: (gas * 130n) / 100n, nonce: await pendingNonce("hashkey", account.address) });
console.log("tx", hash);
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment failed: ${hash}`);
console.log("deployed at", receipt.contractAddress, `https://hashkey.blockscout.com/address/${receipt.contractAddress}`);
writeFileSync(join(here, "deployed.json"), JSON.stringify({ chain: "hashkey", chainId: 177, address: receipt.contractAddress, txHash: hash, deployer: account.address, abi: compiled.abi }, null, 2));
