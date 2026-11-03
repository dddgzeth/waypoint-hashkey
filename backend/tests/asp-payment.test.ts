import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { createAspPlanHandlers, validateInput, ASP_DISCOVERY, aspResourceUrl, aspRequestAudit } from "../src/asp.js";
import { PlanValidationError } from "../src/planner.js";

// No server.ts, live wallets, RPCs, HTTP listeners, or money movement.
// The real x402 SDK runs against a local facilitator double.
const GOAL = "Swap 10 USDC to ETH on Base";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const result = { statusCode: 200, body: { ok: true, status: "planned", executed: false, plan: { steps: [{ id: "step1" }] } } };

test("Bazaar info contains runnable values; schema describes the input/body carrier", () => {
  assert.equal(validateInput(request(ASP_DISCOVERY.info.input.body)).ok, true);
  assert.equal(ASP_DISCOVERY.info.input.method, "POST");
  assert.equal(ASP_DISCOVERY.schema.properties.input.properties.body.properties.goal.type, "string");
  assert.deepEqual(ASP_DISCOVERY.schema.required, ["input"]);
});

test("resource URL remains HTTPS behind HTTP reverse proxy", () => {
  const previous = process.env.ASP_PUBLIC_URL;
  try {
    delete process.env.ASP_PUBLIC_URL;
    assert.equal(aspResourceUrl(), "https://waypoint.cjlin.com/asp/plan");
    for (const value of ["http://waypoint.cjlin.com/asp/plan", "https://user:secret@waypoint.cjlin.com/asp/plan", "https://waypoint.cjlin.com/asp/plan?secret=x"]) {
      process.env.ASP_PUBLIC_URL = value;
      assert.throws(aspResourceUrl);
    }
  } finally {
    if (previous === undefined) delete process.env.ASP_PUBLIC_URL;
    else process.env.ASP_PUBLIC_URL = previous;
  }
});

test("audit correlates input without recording prompt, wallet, or signed header", () => {
  const req = request({ goal: GOAL, walletAddress: ADDRESS }, {}, { "payment-signature": "SECRET_SIGNATURE" });
  const audit = aspRequestAudit(req);
  assert.equal(audit.hasPayment, true);
  assert.equal(audit.inputHash?.length, 20);
  const serialized = JSON.stringify(audit);
  for (const secret of [GOAL, ADDRESS, "SECRET_SIGNATURE"]) assert.equal(serialized.includes(secret), false);
  assert.equal(audit.inputHash, aspRequestAudit(request({ goal: GOAL, walletAddress: ADDRESS })).inputHash);
});

function request(body: unknown = {}, query: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const allHeaders = { host: "waypoint.test", ...headers };
  return {
    method: "POST", path: "/asp/plan", originalUrl: "/asp/plan", protocol: "https",
    body, query, headers: allHeaders, socket: { remoteAddress: "127.0.0.1" },
    header: (name: string) => allHeaders[name.toLowerCase() as keyof typeof allHeaders],
  } as unknown as Request;
}

class TestResponse {
  statusCode = 200;
  locals: Record<string, unknown> = {};
  headers = new Map<string, string>();
  text = "";
  status(code: number) { this.statusCode = code; return this; }
  setHeader(name: string, value: unknown) { this.headers.set(name.toLowerCase(), String(value)); return this; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
  removeHeader(name: string) { this.headers.delete(name.toLowerCase()); }
  type(value: string) { return this.setHeader("content-type", value); }
  json(body: unknown) { return this.type("application/json").send(JSON.stringify(body)); }
  send(body: unknown) { this.end(body); return this; }
  writeHead() { return this; }
  flushHeaders() {}
  write(body: unknown) { this.text += String(body); return true; }
  end(body?: unknown) { if (body !== undefined) this.text += String(body); return this; }
  asExpress() { return this as unknown as Response; }
}

async function check(handlers: ReturnType<typeof createAspPlanHandlers>, req = request({ goal: GOAL })) {
  const res = new TestResponse();
  let next = false;
  await handlers.preCheck(req, res.asExpress(), () => { next = true; });
  return { res, next };
}

test("invalid bodies, goal types, whitespace, repeated params, and invalid wallets stop before payment", async () => {
  let calls = 0;
  const handlers = createAspPlanHandlers(async () => { calls++; return result; });
  for (const body of [null, [], "bad", { goal: 123 }, { goal: null }, { goal: "" }, { goal: "   " },
    { goal: "test" }, { goal: "!!!!!!" }, { goal: "a".repeat(601) },
    { goal: [GOAL] }, { goal: GOAL, walletAddress: "0x123" }, { walletAddress: null }]) {
    const { res, next } = await check(handlers, request(body));
    assert.equal(next, false, JSON.stringify(body));
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers.has("payment-required"), false);
  }
  assert.equal(calls, 0);
});

test("omitted goal is the documented default; body/query/form/alias values normalize consistently", () => {
  assert.deepEqual(validateInput(request()), validateInput(request({ goal: "Supply 100 USD₮0 on X Layer into Aave" })));
  assert.deepEqual(validateInput(request(undefined)), validateInput(request()));
  const expected = validateInput(request({ goal: GOAL, walletAddress: ADDRESS }));
  assert.deepEqual(validateInput(request({}, { goal: GOAL, walletAddress: ADDRESS })), expected);
  assert.deepEqual(validateInput(request({ goalText: " " + GOAL + " ", walletAddress: ADDRESS })), expected);
  assert.deepEqual(validateInput(request(Object.fromEntries(new URLSearchParams({ goal: GOAL, walletAddress: ADDRESS })))), expected);
  assert.equal(validateInput(request({ goal: GOAL }, { goal: "Bridge 20 USDC from Base to Arbitrum" })).ok, false);
  assert.equal(validateInput(request({}, { goal: [GOAL, GOAL] })).ok, false);
});

test("clarification and complete-plan validation failures cannot reach payment", async () => {
  const unclear = createAspPlanHandlers(async () => ({
    statusCode: 422, body: { ok: false, charged: false, status: "needs_clarification", question: "Which asset?" },
  }));
  const invalid = createAspPlanHandlers(async () => { throw new PlanValidationError("unsupported destination"); });
  for (const handlers of [unclear, invalid]) {
    const { res, next } = await check(handlers);
    assert.equal(next, false);
    assert.equal(res.statusCode, 422);
    assert.equal(JSON.parse(res.text).charged, false);
  }
});

test("upstream errors happen before payment and do not poison later retries", async () => {
  let calls = 0;
  const handlers = createAspPlanHandlers(async () => {
    if (++calls === 1) throw new Error("upstream unavailable");
    return result;
  });
  const failed = await check(handlers);
  assert.equal(failed.next, false);
  assert.equal(failed.res.statusCode, 500);
  assert.equal(JSON.parse(failed.res.text).charged, false);
  assert.equal((await check(handlers)).next, true);
  assert.equal(calls, 2);
});

test("paid replay delivers the precomputed result with no additional planner call", async () => {
  let calls = 0;
  const handlers = createAspPlanHandlers(async () => {
    if (++calls > 1) throw new Error("RPC went offline after challenge");
    return result;
  });
  assert.equal((await check(handlers)).next, true);
  const replay = await check(handlers);
  assert.equal(replay.next, true);
  handlers.handlePlan(request(), replay.res.asExpress());
  assert.deepEqual(JSON.parse(replay.res.text), result.body);
  assert.equal(calls, 1);
});

test("cache keys separate requested goals and wallets", async () => {
  let calls = 0;
  const handlers = createAspPlanHandlers(async () => { calls++; return result; });
  await check(handlers);
  await check(handlers, request({ goal: GOAL, walletAddress: ADDRESS }));
  await check(handlers, request({ goal: "Bridge 20 USDC from Base to Arbitrum" }));
  await check(handlers);
  assert.equal(calls, 3);
});

test("a different marketplace egress IP reuses the validated result before signed replay", async () => {
  let calls = 0;
  const handlers = createAspPlanHandlers(async () => { calls++; return result; });
  await check(handlers, request({ goal: GOAL }, {}, { "cf-connecting-ip": "192.0.2.1" }));
  const replay = await check(handlers, request({ goal: GOAL }, {}, { "cf-connecting-ip": "192.0.2.2", "payment-signature": "signed" }));
  assert.equal(replay.next, true);
  assert.equal(replay.res.locals.aspCache, "hit");
  assert.equal(calls, 1);
});

test("concurrent identical requests share preparation", async () => {
  let calls = 0;
  const handlers = createAspPlanHandlers(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return result;
  });
  const responses = await Promise.all([check(handlers), check(handlers), check(handlers)]);
  assert.ok(responses.every((r) => r.next));
  assert.equal(calls, 1);
});

test("prepared replay bypasses a newly exhausted quota", async () => {
  const old = process.env.ASP_RATE_PER_CLIENT_HOUR;
  process.env.ASP_RATE_PER_CLIENT_HOUR = "1";
  try {
    const handlers = createAspPlanHandlers(async () => result);
    assert.equal((await check(handlers)).next, true);
    const other = await check(handlers, request({ goal: "Bridge 20 USDC from Base to Arbitrum" }));
    assert.equal(other.res.statusCode, 429);
    assert.equal(other.next, false);
    assert.equal((await check(handlers)).next, true);
  } finally {
    if (old === undefined) delete process.env.ASP_RATE_PER_CLIENT_HOUR;
    else process.env.ASP_RATE_PER_CLIENT_HOUR = old;
  }
});

test("prepared replay remains deliverable while other preparation is at capacity", async () => {
  const old = process.env.ASP_MAX_CONCURRENT;
  process.env.ASP_MAX_CONCURRENT = "1";
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const handlers = createAspPlanHandlers(async ({ goal }) => {
    if (goal !== GOAL) await barrier;
    return result;
  });
  try {
    await check(handlers);
    const running = check(handlers, request({ goal: "Bridge 20 USDC from Base to Arbitrum" }));
    const blocked = await check(handlers, request({ goal: "Send 5 USDC to another wallet" }));
    assert.equal(blocked.res.statusCode, 429);
    assert.equal(blocked.next, false);
    assert.equal((await check(handlers)).next, true);
    release();
    await running;
  } finally {
    release();
    if (old === undefined) delete process.env.ASP_MAX_CONCURRENT;
    else process.env.ASP_MAX_CONCURRENT = old;
  }
});

test("timeout returns before payment; late completion does not seed a cached plan", async () => {
  let calls = 0;
  const handlers = createAspPlanHandlers(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return result;
  }, 2);
  const failed = await check(handlers);
  assert.equal(failed.res.statusCode, 504);
  assert.equal(failed.next, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await check(handlers)).res.statusCode, 504);
  assert.equal(calls, 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test("real x402 middleware issues 402 after preparation, then settles only the cached 200 response", async () => {
  const events: string[] = [];
  const handlers = createAspPlanHandlers(async () => { events.push("prepare"); return result; });
  const facilitator = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196" as const }], extensions: [], signers: {} }; },
    async verify() { events.push("verify"); return { isValid: true, payer: ADDRESS }; },
    async settle() { events.push("settle"); return { success: true, transaction: "test-only", network: "eip155:196" as const, payer: ADDRESS }; },
  };
  const server = new x402ResourceServer(facilitator).register("eip155:196", new ExactEvmScheme());
  const pay = paymentMiddleware({
    "POST /asp/plan": { accepts: { scheme: "exact", price: "$0.02", network: "eip155:196", payTo: ADDRESS }, mimeType: "application/json" },
  }, server);
  const dispatch = async (req: Request) => {
    const { res, next } = await check(handlers, req);
    if (next) await pay(req, res.asExpress(), (err) => {
      if (err) throw err;
      events.push("deliver");
      handlers.handlePlan(req, res.asExpress());
    });
    return res;
  };
  const first = await dispatch(request({ goal: GOAL }));
  assert.equal(first.statusCode, 402);
  assert.deepEqual(events, ["prepare"]);
  const challenge = JSON.parse(Buffer.from(first.getHeader("payment-required")!, "base64").toString());
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.accepts[0].amount, "20000");
  const signature = Buffer.from(JSON.stringify({
    x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: {},
  })).toString("base64");
  const paid = await dispatch(request({ goal: GOAL }, {}, { "payment-signature": signature }));
  assert.equal(paid.statusCode, 200);
  assert.ok(paid.getHeader("payment-response"));
  assert.deepEqual(JSON.parse(paid.text), result.body);
  assert.deepEqual(events, ["prepare", "verify", "deliver", "settle"]);
  const malformed = await dispatch(request({ goal: 999 }, {}, { "payment-signature": signature }));
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(events, ["prepare", "verify", "deliver", "settle"]);
  const bare = await dispatch(request());
  assert.equal(bare.statusCode, 402);
  assert.ok(bare.getHeader("payment-required"));
  assert.equal(events.filter((event) => event === "prepare").length, 2);
  const queryReplay = await dispatch(request({}, { goal: GOAL }, { "payment-signature": signature }));
  assert.equal(queryReplay.statusCode, 200);
  assert.deepEqual(JSON.parse(queryReplay.text), result.body);
  assert.equal(events.filter((event) => event === "prepare").length, 2);
});
