import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";

const BASE = "http://127.0.0.1:8787";
const walletA = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY.startsWith("0x") ? process.env.EXECUTOR_PRIVATE_KEY : `0x${process.env.EXECUTOR_PRIVATE_KEY}`);
const executionWalletAddress = "0xbB88fa3e0e038b2A2B1D22214407D78Eea239408";
const executionWalletId = "x70tk73nfiige3q4xwl6kw6h";

async function api(path, opts = {}, cookie) {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) } });
  const setCookie = res.headers.get("set-cookie");
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return { body, cookie: setCookie ? setCookie.split(";")[0] : cookie };
}

const { body: nonceBody } = await api("/auth/nonce");
const msg = new SiweMessage({ domain: "127.0.0.1", address: walletA.address, statement: "Sign in to Waypoint.", uri: "http://127.0.0.1:8787", version: "1", chainId: 1, nonce: nonceBody.nonce, issuedAt: new Date().toISOString() });
const prepared = msg.prepareMessage();
const sig = await walletA.signMessage({ message: prepared });
const { cookie } = await api("/auth/login", { method: "POST", body: JSON.stringify({ message: prepared, signature: sig }) });

const chat = await api("/chat", { method: "POST", body: JSON.stringify({ message: `Send 0.1 USDC on Polygon from my execution wallet to ${walletA.address}.`, walletAddress: executionWalletAddress }) }, cookie);
console.log("Plan ready, executing via /execute/stream...\n");

const res = await fetch(`${BASE}/execute/stream`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ plan: chat.body.plan, walletId: executionWalletId }),
});

const t0 = Date.now();
for await (const chunk of res.body) {
  const text = Buffer.from(chunk).toString("utf-8");
  for (const line of text.split("\n\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s] EVENT:`, JSON.stringify(event));
  }
}
