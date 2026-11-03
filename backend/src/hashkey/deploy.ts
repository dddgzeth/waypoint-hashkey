#!/usr/bin/env tsx
/**
 * Deploys WaypointStrategyLog to HashKey Chain mainnet with the wallet in secrets/hashkey-wallet.json.
 * Dry run by default (compiles, simulates and estimates gas); pass --execute to broadcast.
 *   npx tsx src/hashkey/deploy.ts [--execute]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeDeployData, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashkey } from "../chains/hashkey.js";
import { compileSolidity } from "../contracts/compiler.js";
import { lintSolidity } from "../contracts/lint.js";

const here = dirname(fileURLToPath(import.meta.url));
const execute = process.argv.includes("--execute");

const source = readFileSync(join(here, "WaypointStrategyLog.sol"), "utf8");
const issues = lintSolidity(source);
if (issues.length) throw new Error(`Lint failed: ${issues.map((i) => i.message).join("; ")}`);
const compiled = compileSolidity(source, "WaypointStrategyLog");
const data = encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode });

const wallet = JSON.parse(readFileSync(join(here, "../../secrets/hashkey-wallet.json"), "utf8")) as { address: string; privateKey: string };
const account = privateKeyToAccount(wallet.privateKey.startsWith("0x") ? (wallet.privateKey as `0x${string}`) : (`0x${wallet.privateKey}` as `0x${string}`));
const client = createPublicClient({ chain: hashkey.viemChain, transport: http(hashkey.publicRpc) });

const balance = await client.getBalance({ address: account.address });
await client.call({ account: account.address, data });
const gas = await client.estimateGas({ account: account.address, data });
const gasPrice = await client.getGasPrice();
console.log(`wallet ${account.address}  balance ${formatEther(balance)} HSK`);
console.log(`compiled ${compiled.name}  bytecode ${(compiled.bytecode.length - 2) / 2} bytes  gas ${gas}  cost ~${formatEther(gas * gasPrice)} HSK`);
if (!execute) {
  console.log("dry run OK (simulation passed). Re-run with --execute to deploy.");
  process.exit(0);
}
if (balance < gas * gasPrice * 2n) throw new Error("Not enough HSK to deploy");

const walletClient = createWalletClient({ account, chain: hashkey.viemChain, transport: http(hashkey.publicRpc) });
const hash = await walletClient.sendTransaction({ data, gas: (gas * 130n) / 100n });
console.log("tx", hash);
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment failed: ${hash}`);
console.log("deployed at", receipt.contractAddress, `https://hashkey.blockscout.com/address/${receipt.contractAddress}`);
writeFileSync(join(here, "deployed.json"), JSON.stringify({ chain: "hashkey", chainId: 177, address: receipt.contractAddress, txHash: hash, abi: compiled.abi }, null, 2));
