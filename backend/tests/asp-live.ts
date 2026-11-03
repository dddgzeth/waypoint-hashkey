/** Explicit, opt-in production QA. `unpaid` never signs; `paid <case>` costs $0.02.
 * No app server import and no swap/bridge execution. Never log signed headers.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { registerExactEvmScheme } from "@okxweb3/x402-evm/exact/client";
import { createPublicClient, erc20Abi, parseEventLogs } from "viem";
import { getExecutionAccount } from "../src/wallets/privy.js";
import { getChain } from "../src/chains/index.js";
import { alchemyHttp } from "../src/adapters/alchemyTransport.js";

const endpoint = "https://waypoint.cjlin.com/asp/plan";
const payer = "0x4ffa3175f9d2c71531a107c40b3b7a8543b9ec29";
const seller = "0x7a80299a84c3775d62da1cd4a9d59b1524d7bf0f";
const token = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const example = "Supply 100 USD₮0 on X Layer into Aave";
const pc = createPublicClient({ chain: getChain("xlayer")!.viemChain, transport: alchemyHttp("xlayer") });
const balance = (address: `0x${string}`, blockNumber?: bigint) => pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber });
const out = (value: unknown) => console.log(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v));

async function request(body?: unknown, headers: Record<string, string> = {}, query = "", raw = false, method = "POST") {
  const start = Date.now();
  const r = await fetch(endpoint + query, { method, headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { nonJson: text.slice(0, 160) }; }
  return { r, data, ms: Date.now() - start };
}
function check(label: string, x: Awaited<ReturnType<typeof request>>, status: number) {
  out({ label, http: x.r.status, ms: x.ms, challenge: x.r.headers.has("payment-required"), settlement: x.r.headers.has("payment-response"), error: x.data.error, question: x.data.question });
  assert.equal(x.r.status, status, label);
  assert.equal(x.r.headers.has("payment-required"), status === 402, label);
  assert.equal(x.r.headers.has("payment-response"), false, label);
  if (status === 402) {
    const challenge = JSON.parse(Buffer.from(x.r.headers.get("payment-required")!, "base64").toString());
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.resource.url, endpoint);
    const bazaar = challenge.extensions.bazaar;
    assert.equal(bazaar.info.input.method, "POST");
    assert.equal(bazaar.info.input.body.goal, example);
    assert.equal(bazaar.schema.properties.input.properties.body.properties.goal.type, "string");
  }
}
async function unpaid() {
  check("bare POST", await request(), 402);
  check("empty object", await request({}), 402);
  for (const body of [{ goal: null }, { goal: "" }, { goal: 12 }, { goal: [example] }, { goal: "test" }, { goal: "!!!!!!" }, { goal: "a".repeat(601) }, { walletAddress: "0x123" }, [], { walletAddress: null }]) {
    check("invalid " + JSON.stringify(body).slice(0, 80), await request(body), 400);
  }
  check("malformed JSON", await request("{bad", {}, "", true), 400);
  check("unsupported media", await request(example, { "content-type": "text/plain" }, "", true), 415);
  check("query", await request(undefined, {}, "?goal=" + encodeURIComponent(example)), 402);
  check("form", await request(new URLSearchParams({ goal: example }).toString(), { "content-type": "application/x-www-form-urlencoded" }, "", true), 402);
  check("query conflict", await request({ goal: "Swap 10 USDC to ETH on Base" }, {}, "?goal=" + encodeURIComponent(example)), 400);
  check("unclear goal", await request({ goal: "make me some money onchain" }), 422);
  check("unsupported chain", await request({ goal: "Bridge 5 USDC from Base to Dogecoin" }), 422);
  check("GET descriptor", await request(undefined, {}, "", false, "GET"), 200);
}
async function paid(name: string) {
  const cases: Record<string, unknown> = {
    default: {},
    example: { goal: example },
    crosschain: { goal: "Bridge 20 USDC from Base to X Layer and supply it to Aave" },
    wallet: { goal: "Swap 0.1 USD₮0 to USDC on X Layer", walletAddress: payer },
  };
  assert.ok(Object.hasOwn(cases, name), "Unknown paid case");
  const body = cases[name];
  const first = await request(body);
  check(name + " probe", first, 402);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: getExecutionAccount("tvxzxx2vmx7wxg2q74fo38vx", payer) as never });
  const http = new x402HTTPClient(client);
  const required = http.getPaymentRequiredResponse((key) => first.r.headers.get(key));
  assert.equal(required.accepts.length, 1);
  const terms = required.accepts[0]!;
  assert.equal(terms.scheme, "exact");
  assert.equal(terms.network, "eip155:196");
  assert.equal(terms.asset.toLowerCase(), token);
  assert.equal(terms.payTo.toLowerCase(), seller);
  assert.equal(terms.amount, "20000");
  assert.ok(await balance(payer) >= 20000n, "Insufficient test funds");
  out({ label: "signing approved test payment", case: name, amount: "0.02 USD₮0", network: terms.network, payTo: terms.payTo });
  const payload = await client.createPaymentPayload(required);
  const headers = http.encodePaymentSignatureHeader(payload);
  // Even a signed invalid request must be rejected without settling. Reuse this
  // still-unspent authorization immediately for its intended valid request.
  const before = await balance(payer);
  check("signed invalid input", await request({ goal: null }, headers), 400);
  assert.equal(await balance(payer), before, "Invalid input changed buyer balance");
  const replay = await request(body, headers);
  const encoded = replay.r.headers.get("payment-response");
  const settlement = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString()) : null;
  out({ label: name + " paid replay", http: replay.r.status, ms: replay.ms, settlement, response: replay.data });
  assert.equal(replay.r.status, 200);
  assert.equal(replay.data.ok, true);
  assert.equal(replay.data.status, "planned");
  assert.equal(replay.data.executed, false);
  assert.ok(replay.data.plan.steps.length > 0);
  assert.equal(settlement?.success, true);
  assert.equal(settlement.network, "eip155:196");
  assert.match(settlement.transaction, /^0x[0-9a-f]{64}$/i);
  const receipt = await pc.waitForTransactionReceipt({ hash: settlement.transaction, timeout: 90_000 });
  assert.equal(receipt.status, "success");
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((log) => log.address.toLowerCase() === token) });
  assert.ok(transfers.some(({ args }) => args.from.toLowerCase() === payer && args.to.toLowerCase() === seller && args.value === 20000n), "Missing exact payer-to-seller transfer");
  const p0 = await balance(payer, receipt.blockNumber - 1n);
  const p1 = await balance(payer, receipt.blockNumber);
  const s0 = await balance(seller, receipt.blockNumber - 1n);
  const s1 = await balance(seller, receipt.blockNumber);
  out({ label: "verified onchain", case: name, transaction: receipt.transactionHash, block: receipt.blockNumber,
    status: receipt.status, payerDelta: p1 - p0, sellerDelta: s1 - s0, transfers: transfers.map((log) => log.args) });
  assert.equal(p1 - p0, -20000n);
  assert.equal(s1 - s0, 20000n);
}

try {
  if (process.argv[2] === "unpaid") await unpaid();
  else if (process.argv[2] === "paid") await paid(process.argv[3] ?? "default");
  else throw new Error("Usage: node --import tsx tests/asp-live.ts unpaid | paid <default|example|crosschain|wallet>");
  out({ result: "PASS", completedAt: new Date().toISOString() });
} catch (error) {
  // SDK exceptions may carry request headers. Print only the message, never the
  // whole error object (which could expose credentials/payment authorization).
  out({ result: "FAIL", error: error instanceof Error ? error.message : "Unknown failure" });
  process.exitCode = 1;
}
