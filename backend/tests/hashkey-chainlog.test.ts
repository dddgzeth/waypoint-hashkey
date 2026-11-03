import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeFunctionResult, keccak256, numberToHex, pad } from "viem";
import { chainLogAddress, recordCalldata, registerCalldata, stopCalldata, STRATEGY_LOG_ABI } from "../src/hashkey/chainlog.js";
import { DEFAULT_STRATEGY } from "../src/hashkey/strategy.js";

// Dry run only: the contract's runtime code is injected at a throwaway address with eth_call state overrides
// on HashKey mainnet, so nothing is deployed or sent. Needs network access to the public RPC.
const RPC = "https://mainnet.hsk.xyz";
const LOG = "0x00000000000000000000000000000000000c0de1" as const;
const OWNER = "0x98d50f1e66ad28ad1beeb377e83c940ea8ca5568" as const;
const STRANGER = "0x0000000000000000000000000000000000000bad" as const;

const solc = createRequire(import.meta.url)("solc") as { compile(i: string): string };
const source = readFileSync(new URL("../src/hashkey/WaypointStrategyLog.sol", import.meta.url), "utf8");
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "C.sol": { content: source } }, settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } } } })));
const runtime = `0x${out.contracts["C.sol"].WaypointStrategyLog.evm.deployedBytecode.object}`;

const word = (n: bigint | number) => pad(numberToHex(BigInt(n)), { size: 32 });
// `strategies` is the contract's only storage variable (slot 0 = length); element 0 starts at keccak256(0), owner in its first slot.
const base = BigInt(keccak256(word(0)));
const withStrategy = (owner: `0x${string}`) => ({ [LOG]: { code: runtime, stateDiff: { [word(0)]: word(1), [word(base)]: pad(owner, { size: 32 }), [word(base + 5n)]: word(0x010000 | 10000) } } });
const bare = { [LOG]: { code: runtime } };

async function call(from: string, data: string, override: object) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to: LOG, data }, "latest", override] }) });
  return (await res.json()) as { result?: string; error?: { message: string } };
}

const reading = { poolPrice: 0.0875, refPrice: 0.091 };

test("no contract configured: the chain log stays off", () => {
  const saved = process.env.HASHKEY_STRATEGY_LOG;
  delete process.env.HASHKEY_STRATEGY_LOG;
  try {
    // Without HASHKEY_STRATEGY_LOG and without hashkey/deployed.json the agent must not touch the chain.
    const deployed = new URL("../src/hashkey/deployed.json", import.meta.url);
    let exists = true;
    try { readFileSync(deployed); } catch { exists = false; }
    if (!exists) assert.equal(chainLogAddress(), null);
  } finally {
    if (saved !== undefined) process.env.HASHKEY_STRATEGY_LOG = saved;
  }
});

test("registerStrategy calldata is accepted by the contract and returns id 0", async () => {
  const r = await call(OWNER, registerCalldata("HSK", DEFAULT_STRATEGY, reading), bare);
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(decodeFunctionResult({ abi: STRATEGY_LOG_ABI, functionName: "registerStrategy", data: r.result as `0x${string}` }), 0n);
});

test("registerCalldata keeps stop < take even when the pool is far above the reference", async () => {
  const r = await call(OWNER, registerCalldata("ETH", DEFAULT_STRATEGY, { poolPrice: 2400, refPrice: 2200 }), bare);
  assert.equal(r.error, undefined, r.error?.message);
});

test("recordExecution (buy and sell) and stopStrategy succeed for the owner", async () => {
  const txHash = `0x${"ab".repeat(32)}`;
  for (const side of ["buy", "sell"] as const) {
    const r = await call(OWNER, recordCalldata(0n, { side, usdt: 12.49, qty: 142.2769, decimals: 18, txHash, takeProfit: side === "sell" }), withStrategy(OWNER));
    assert.equal(r.error, undefined, r.error?.message);
  }
  const stop = await call(OWNER, stopCalldata(0n), withStrategy(OWNER));
  assert.equal(stop.error, undefined, stop.error?.message);
});

test("a different sender cannot record or stop (NotOwner)", async () => {
  const txHash = `0x${"cd".repeat(32)}`;
  const rec = await call(STRANGER, recordCalldata(0n, { side: "buy", usdt: 5, qty: 1, decimals: 18, txHash, takeProfit: false }), withStrategy(OWNER));
  assert.ok(rec.error, "expected a revert");
  const stop = await call(STRANGER, stopCalldata(0n), withStrategy(OWNER));
  assert.ok(stop.error, "expected a revert");
});
