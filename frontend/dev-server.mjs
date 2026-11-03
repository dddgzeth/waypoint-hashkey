#!/usr/bin/env node
// Local design-preview server. No dependencies, no network calls out, no keys.
//   node dev-server.mjs [port]      then open http://localhost:5173
// Serves index.html and app.html and answers the app's API calls with demo data,
// so every screen can be reviewed without the real backend (and without touching any real wallet).
// Signing in with any email/password works. Executing a plan is disabled in preview.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const CHAINS = [
  { key: "ethereum", label: "Ethereum", aave: true, chainId: 1, explorerUrl: "https://etherscan.io" },
  { key: "base", label: "Base", aave: true, chainId: 8453, explorerUrl: "https://basescan.org" },
  { key: "arbitrum", label: "Arbitrum", aave: true, chainId: 42161, explorerUrl: "https://arbiscan.io" },
  { key: "polygon", label: "Polygon", aave: true, chainId: 137, explorerUrl: "https://polygonscan.com" },
  { key: "xlayer", label: "X Layer", aave: true, chainId: 196, explorerUrl: "https://www.oklink.com/xlayer" },
];

const LINKED = [{ address: "0x6a2c62fa9ca0c397187db8ae948c14b76dd5c28b", label: "Main wallet" }];
const EXEC = [
  { walletId: "demo-exec-1", address: "0xc97b39df0faaa7a2071404a180dab504ca9ce661", label: "Execution wallet 1" },
  { walletId: "demo-exec-2", address: "0x4ffa3175f9d2c71531a107c40b3b7a8543b9ec29", label: "Savings" },
];
const BAL = {
  [LINKED[0].address]: [
    ["ethereum", "ETH", 0.0737, 198.0], ["ethereum", "USDC", 40.76, 40.76], ["base", "ETH", 0.0158, 42.52],
    ["arbitrum", "USD₮0", 64.42, 64.4], ["arbitrum", "ETH", 0.0056, 14.96], ["polygon", "USDC", 158.51, 158.57],
  ],
  [EXEC[0].address]: [
    ["base", "USDC", 1.82, 1.82], ["base", "ETH", 0.0014, 3.87], ["xlayer", "OKB", 0.0068, 0.83], ["ethereum", "ETH", 0.0035, 9.3],
  ],
  [EXEC[1].address]: [
    ["xlayer", "USDC", 0.98, 0.98], ["xlayer", "OKB", 0.0285, 3.46], ["base", "USDC", 1.99, 1.99], ["arbitrum", "ETH", 0.0019, 5.23],
  ],
};
const DEFI = {
  [LINKED[0].address]: {
    summary: { suppliedUsd: 1240.5, borrowedUsd: 310.25, netUsd: 930.25 },
    markets: [{
      chain: "base", officialUrl: "https://app.aave.com", suppliedUsd: 1240.5, borrowedUsd: 310.25, netUsd: 930.25, healthFactor: 3.42, noDebt: false,
      assets: [
        { symbol: "USDC", assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", supplied: 1240.5, suppliedUsd: 1240.5, borrowed: 0, borrowedUsd: 0, usedAsCollateral: true, supplyApy: 4.12, variableBorrowApr: 0 },
        { symbol: "WETH", assetAddress: "0x4200000000000000000000000000000000000006", supplied: 0, suppliedUsd: 0, borrowed: 0.115, borrowedUsd: 310.25, usedAsCollateral: false, supplyApy: 0, variableBorrowApr: 2.31 },
      ],
    }],
  },
};
const emptyDefi = { summary: { suppliedUsd: 0, borrowedUsd: 0, netUsd: 0 }, markets: [] };
const TRIGGERS = [
  { triggerId: "t1", triggerType: "dca", active: true, executionWalletId: "demo-exec-1", lastCheckedAt: Date.now() - 40000, lastFiredAt: Date.now() - 86400000 * 2,
    config: { type: "dca", chain: "base", tokenIn: "USDC", tokenOut: "ETH", amountPerBuy: 10, timeOfDayUtc: "09:00" } },
  { triggerId: "t2", triggerType: "health_factor", active: true, executionWalletId: "demo-exec-1", lastCheckedAt: Date.now() - 20000, lastFiredAt: null,
    config: { type: "health_factor", chain: "base", threshold: 1.5, repayAsset: "WETH", repayPercent: 25 } },
];
const SESSIONS = [
  { sessionId: "s1", title: "Bridge 20 USDC from Base to X Layer" },
  { sessionId: "s2", title: "Move idle USDC to the best Aave yield" },
];

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8" };
const json = (res, code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const signedIn = (req) => /(?:^|;\s*)wp_demo=1/.test(req.headers.cookie || "") || /[?&]shot=/.test(req.headers.referer || "");
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
let FAST = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? 0 : ms));

const BADGE = `<style>.wp-preview{position:fixed;right:12px;bottom:12px;z-index:99;font:500 11px/1 Inter,system-ui,sans-serif;color:#5B6275;background:#FBF8F0;border:1px solid #E0D8C5;border-radius:6px;padding:6px 9px;pointer-events:none}@media(max-width:860px){.wp-preview{bottom:64px}}</style><div class="wp-preview">Local preview · demo data</div>`;

async function chatStream(req, res) {
  const { message = "" } = JSON.parse((await readBody(req)) || "{}");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  send({ type: "stage", stage: "triage" }); await sleep(450);
  send({ type: "reading_balances" }); await sleep(600);
  if (/^\s*(hi|hello|hey)\b/i.test(message) || message.trim().length < 6) {
    send({ type: "result", kind: "question", sessionId: "s-new", message: "What would you like to do? For example: move idle USDC into the best Aave yield, or bridge funds to X Layer." });
    return res.end();
  }
  send({ type: "goal_parsed", goal: { targetChain: "xlayer", targetAsset: "USDC", needsYieldLookup: false, constraints: [] } }); await sleep(700);
  send({
    type: "result", kind: "plan", sessionId: "s-new",
    message: "Here is the plan. Review each step, then confirm to run it.",
    highRiskSteps: [],
    plan: {
      goal: { targetChain: "xlayer", targetAsset: "USDC", action: message, constraints: [], needsYieldLookup: false },
      steps: [
        { id: "step1", action: "bridge", chainFrom: "base", chainTo: "xlayer", tokenIn: "USDC", tokenOut: "USDC", amountIn: "20", protocol: null, dependsOn: [], vendorAdapter: "relay", transferFrom: null, transferTo: null },
        { id: "step2", action: "protocol_supply", chainFrom: "xlayer", chainTo: "xlayer", tokenIn: "USDC", tokenOut: "USDC", amountIn: "output_of(step1)", protocol: "aave", dependsOn: ["step1"], vendorAdapter: null, transferFrom: null, transferTo: null },
      ],
    },
  });
  res.end();
}

async function executeStream(req, res) {
  await readBody(req);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const H = (n) => "0x" + crypto.createHash("sha256").update("wp-" + n).digest("hex");
  send({ type: "step_start", stepId: "step1", action: "bridge", summary: "bridge 20 USDC (base) -> USDC (xlayer)" }); await sleep(250);
  send({ type: "step_status", stepId: "step1", status: "simulating" }); await sleep(250);
  send({ type: "step_tx", stepId: "step1", label: "approval", chainKey: "base", txHash: H(0xa1) }); await sleep(250);
  send({ type: "step_tx", stepId: "step1", label: "source", chainKey: "base", txHash: H(0xb2) }); await sleep(250);
  send({ type: "step_status", stepId: "step1", status: "bridging", detail: "Waiting for delivery on X Layer" }); await sleep(300);
  send({ type: "step_tx", stepId: "step1", label: "destination", chainKey: "xlayer", txHash: H(0xc3) });
  send({ type: "step_complete", stepId: "step1", result: { actualAmountOut: 19.58, outputSymbol: "USDC" } }); await sleep(250);
  send({ type: "step_start", stepId: "step2", action: "protocol_supply", summary: "protocol_supply 19.58 USDC (xlayer) -> aUSDC (xlayer)" }); await sleep(250);
  send({ type: "step_status", stepId: "step2", status: "sending" }); await sleep(250);
  send({ type: "step_tx", stepId: "step2", label: "source", chainKey: "xlayer", txHash: H(0xd4) });
  send({ type: "step_complete", stepId: "step2", result: { actualAmountOut: 19.58, outputSymbol: "aUSDC" } }); await sleep(250);
  send({ type: "done", results: [{ actualAmountOut: 19.58, outputSymbol: "aUSDC" }, { actualAmountOut: 19.58, outputSymbol: "aUSDC" }] });
  res.end();
}

const SCENE = `<style>.msg{animation:none!important;opacity:1!important}*{caret-color:transparent!important}</style>`;

const server = http.createServer(async (req, res) => {
  FAST = /[?&]shot=/.test(req.headers.referer || "");
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const cors = { "access-control-allow-origin": req.headers.origin || "*", "access-control-allow-credentials": "true" };

  // ---- API (demo data)
  if (p === "/chains") return json(res, 200, { chains: CHAINS }, cors);
  if (p === "/auth/config") return json(res, 200, { googleClientId: null }, cors);
  if (p === "/auth/me") return signedIn(req) ? json(res, 200, { accountId: "acct_demo", wallets: LINKED }, cors) : json(res, 401, { error: "Not signed in" }, cors);
  if (p === "/auth/check-email") return json(res, 200, { exists: true }, cors);
  if (p === "/auth/login-email" || p === "/auth/register") return json(res, 200, { ok: true }, { ...cors, "set-cookie": "wp_demo=1; Path=/; SameSite=Lax" });
  if (p === "/auth/logout") return json(res, 200, { ok: true }, { ...cors, "set-cookie": "wp_demo=; Path=/; Max-Age=0" });
  if (p === "/wallet/execution" && req.method === "GET") return json(res, 200, { wallets: EXEC }, cors);
  if (p === "/wallet/portfolio") {
    const a = (url.searchParams.get("address") || "").toLowerCase();
    const rows = BAL[a] || [];
    return json(res, 200, { balances: rows.map(([chain, token, amount, usdValue]) => ({ chain, token, amount, usdValue, tokenAddress: token === "ETH" || token === "OKB" ? null : "0x0000000000000000000000000000000000000001", decimals: 18, logo: null })), totalUsd: rows.reduce((s, r) => s + r[3], 0) }, cors);
  }
  if (p === "/wallet/defi-positions") return json(res, 200, DEFI[(url.searchParams.get("address") || "").toLowerCase()] || emptyDefi, cors);
  if (p === "/wallet/health-factor") return json(res, 200, { healthFactor: 3.42, noDebt: false }, cors);
  if (p === "/triggers" && req.method === "GET") return json(res, 200, { triggers: TRIGGERS }, cors);
  if (/^\/triggers\/[^/]+\/executions$/.test(p)) return json(res, 200, { executions: [] }, cors);
  if (p === "/trust") return json(res, 200, { trusted: [] }, cors);
  if (p === "/chat/sessions") return json(res, 200, { sessions: SESSIONS }, cors);
  if (/^\/chat\/sessions\/[^/]+$/.test(p)) return json(res, 200, { sessionId: p.split("/").pop(), turns: [] }, cors);
  if (p === "/chat/stream" && req.method === "POST") return chatStream(req, res);
  if (p === "/execute/stream" && req.method === "POST") return executeStream(req, res);
  if (p.startsWith("/execute")) return json(res, 400, { error: "Execution is not available in this preview." }, cors);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  // ---- pages and files
  const route = p === "/" ? "/index.html" : p === "/app" ? "/app.html" : p;
  const file = path.join(DIR, path.normalize(route).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
  let body = fs.readFileSync(file);
  const ext = path.extname(file);
  if (ext === ".html") {
    let html = body.toString("utf8");
    const shot = url.searchParams.has("shot");
    html = html.replace("<head>", `<head><script>window.WAYPOINT_API_BASE=location.origin;</script>`).replace("</body>", `${shot ? SCENE : BADGE}</body>`);
    body = Buffer.from(html);
  }
  res.writeHead(200, { "content-type": mime[ext] || "application/octet-stream", "cache-control": "no-store" });
  res.end(body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Waypoint design preview: http://localhost:${PORT}   (landing)`);
  console.log(`                         http://localhost:${PORT}/app (app, any email + password signs in)`);
});
