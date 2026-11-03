/**
 * Public, stateless planning service for agent marketplaces (OKX.AI A2MCP).
 *
 * POST /asp/plan { goal, walletAddress? } -> a validated multi-step execution plan.
 * It reads public chain state, runs the goal parser and the planner, and returns the
 * plan. It never signs, never executes and never touches an account, a session or an
 * execution wallet. Execution stays behind the authenticated app and its one-time
 * confirmation.
 *
 * Because it is public and every call costs model and RPC usage, it is rate limited
 * (per client and globally) and concurrency capped.
 *
 * Payment (x402, OKX facilitator): when ASP_PAY_TO is set, POST /asp/plan costs ASP_PRICE_USD
 * per call, paid in the network's x402 stablecoin (default X Layer, eip155:196). The caller
 * gets HTTP 402 only after a complete plan has been prepared, signs, and retries.
 * The paid handler only delivers that prepared result. Input errors, clarification,
 * planner failures and capacity checks all happen before the payment middleware.
 * Unset ASP_PAY_TO = free mode.
 */
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { isAddress } from "viem";
import { parseGoal } from "./goalParser.js";
import { buildPlan, PlanValidationError } from "./planner.js";
import { getWalletState } from "./stateReader.js";
import { prettyPlan } from "./capabilities/index.js";
import type { WalletStateSnapshot } from "./models.js";
import { judgeReadiness } from "./agents/readinessAgent.js";
import { publicErrorMessage } from "./errors.js";
import { CHAIN_KEYS, getChain } from "./chains/index.js";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";

const GOAL_MIN = 6;
/** Used when the caller sends no goal, so a bare request (the marketplace self-check) still goes 402 -> pay -> a real plan. */
const DEFAULT_GOAL = "Supply 100 USD₮0 on X Layer into Aave";
const GOAL_MAX = 600;
const HOUR_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 120_000;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const PER_CLIENT_PER_HOUR = () => num(process.env.ASP_RATE_PER_CLIENT_HOUR, 20);
const GLOBAL_PER_HOUR = () => num(process.env.ASP_RATE_GLOBAL_HOUR, 150);
const MAX_CONCURRENT = () => num(process.env.ASP_MAX_CONCURRENT, 3);

function recent(list: number[], now: number): number[] {
  return list.filter((t) => now - t < HOUR_MS);
}

/** Returns seconds to wait if the call is over a limit, else null (and records the call). */
function takeSlot(client: string, perClient: Map<string, number[]>, globalHits: number[]): number | null {
  const now = Date.now();
  while (globalHits.length && now - globalHits[0]! >= HOUR_MS) globalHits.shift();
  const mine = recent(perClient.get(client) ?? [], now);
  if (mine.length >= PER_CLIENT_PER_HOUR()) return Math.ceil((HOUR_MS - (now - mine[0]!)) / 1000);
  if (globalHits.length >= GLOBAL_PER_HOUR()) return Math.ceil((HOUR_MS - (now - globalHits[0]!)) / 1000);
  mine.push(now);
  globalHits.push(now);
  perClient.set(client, mine);
  if (perClient.size > 5000) for (const [k, v] of perClient) if (recent(v, now).length === 0) perClient.delete(k);
  return null;
}

/** Cloudflare fronts the site; nginx forwards its headers. Falls back to the socket address. */
function clientId(req: Request): string {
  const h = (k: string) => (typeof req.headers[k] === "string" ? (req.headers[k] as string) : undefined);
  return h("cf-connecting-ip") ?? h("x-real-ip") ?? req.socket.remoteAddress ?? "unknown";
}

const PAY_TO = () => process.env.ASP_PAY_TO?.trim() || null;
const PRICE_USD = () => process.env.ASP_PRICE_USD?.trim() || "0.05";
const PAY_NETWORK = () => (process.env.ASP_X402_NETWORK?.trim() || "eip155:196") as `${string}:${string}`;

/** Declared request contract, shared by the 400 responses and the x402 challenge so a buyer knows the parameters before it pays. */
const INPUT_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string", minLength: GOAL_MIN, maxLength: GOAL_MAX, description: `The onchain outcome you want. Omit for the demo goal: ${DEFAULT_GOAL}.` },
    walletAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Optional. Plan against this wallet's public balances instead of a demo wallet." },
  },
  required: [],
} as const;
// Bazaar v2 separates example VALUES (info) from the schema of that info.
// Keep this shape aligned with x402's createBodyDiscoveryExtension.
export const ASP_DISCOVERY = {
  info: { input: { type: "http", method: "POST", bodyType: "json", body: { goal: DEFAULT_GOAL } } },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    properties: { input: {
      type: "object", properties: {
        type: { type: "string", const: "http" },
        method: { type: "string", enum: ["POST"] },
        bodyType: { type: "string", enum: ["json"] },
        body: INPUT_SCHEMA,
      }, required: ["type", "method", "bodyType", "body"], additionalProperties: false,
    } }, required: ["input"],
  },
} as const;

export function aspResourceUrl(): string {
  const url = new URL(process.env.ASP_PUBLIC_URL || "https://waypoint.cjlin.com/asp/plan");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/asp/plan") {
    throw new Error("ASP_PUBLIC_URL must be an HTTPS /asp/plan URL without credentials, query or fragment");
  }
  return url.href;
}

/** Diagnostic output is allowlisted: no signatures, cookies, API keys, wallet
 * addresses or raw prompts. Hashes correlate equivalent requests across IPs. */
export function aspRequestAudit(req: Request) {
  const shape = (value: unknown) => value === undefined ? "absent" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const v = validateInput(req);
  return {
    bodyType: shape(req.body),
    goalType: shape(req.body?.goal ?? req.query?.goal),
    hasGoal: req.body?.goal !== undefined || req.query?.goal !== undefined || req.body?.goalText !== undefined || req.query?.goalText !== undefined,
    walletType: shape(req.body?.walletAddress ?? req.query?.walletAddress),
    hasPayment: Boolean(req.headers["payment-signature"] || req.headers["x-payment"]),
    inputHash: v.ok ? createHash("sha256").update(JSON.stringify(v.value)).digest("hex").slice(0, 20) : null,
    invalidField: v.ok ? null : v.field,
  };
}

/** Structured validation failure: names the missing/invalid field and carries the schema. Always HTTP 400, never after a payment request. */
function badInput(res: Response, error: string, field: string) {
  res.status(400).json({ ok: false, charged: false, error, missing: [field], required: [], fields: INPUT_SCHEMA.properties, inputSchema: INPUT_SCHEMA });
}

const DESCRIPTOR = () => ({
  ok: true,
  service: "Waypoint Plan",
  description:
    "Turn one plain-language onchain goal into a validated, dependency-ordered, multi-step cross-chain execution plan " +
    "(swap, bridge, Aave supply/withdraw/borrow, transfer, custom contract call). Read-only: it plans, it does not sign or execute.",
  endpoint: "POST /asp/plan",
  input: {
    goal: `string, ${GOAL_MIN}-${GOAL_MAX} characters, the outcome you want. Optional: if omitted, the example goal "${DEFAULT_GOAL}" is planned.`,
    walletAddress: "0x address, optional. If set, the plan is built against that wallet's real public balances; otherwise against a demo wallet.",
  },
  output: {
    plan: "ordered steps with chain, asset, amount and provider per step, and dependencies between steps",
    goal: "the structured goal parsed from your text",
    summary: "the plan as readable text",
    status: '"planned" with a plan. Unclear goals receive HTTP 422 before any payment challenge.',
    executed: "always false",
  },
  supportedChains: CHAIN_KEYS,
  example: {
    goal: "Supply 100 USD₮0 on X Layer into Aave",
  },
  limits: { perClientPerHour: PER_CLIENT_PER_HOUR(), globalPerHour: GLOBAL_PER_HOUR() },
  pricing: PAY_TO()
    ? {
        model: "x402 pay-per-call",
        pricePerPlanUsd: PRICE_USD(),
        network: PAY_NETWORK(),
        payTo: PAY_TO(),
        charged: "only when a plan is returned (HTTP 200); clarification questions (422), errors and rate limits are free",
      }
    : { model: "free" },
});

export type ParsedInput = { goal: string; walletAddress?: string };

/** Deterministic request validation. Must run before any payment challenge: a caller is never asked to sign for a request that cannot succeed. */
export function validateInput(req: Request): { ok: true; value: ParsedInput } | { ok: false; error: string; field: string } {
  if (req.body !== undefined && (req.body === null || typeof req.body !== "object" || Array.isArray(req.body))) {
    return { ok: false, error: "request body must be an object", field: "body" };
  }
  const body = req.body ?? {};
  const query = req.query ?? {};
  // Query/form carriers are accepted too; conflicting values must not silently
  // change the requested goal between the probe and the paid replay.
  const values = (names: string[]) => [body, query].flatMap((source) => names.map((name) => source[name]).filter((v) => v !== undefined));
  const goals = values(["goal", "goalText"]);
  if (goals.some((v) => typeof v !== "string")) return { ok: false, error: "goal must be a string", field: "goal" };
  if (new Set(goals.map((v) => (v as string).trim())).size > 1) return { ok: false, error: "conflicting goal values", field: "goal" };
  const goal = goals.length ? (goals[0] as string).trim() : DEFAULT_GOAL;
  if (goal.length < GOAL_MIN || goal.length > GOAL_MAX) return { ok: false, error: `goal must be ${GOAL_MIN}-${GOAL_MAX} characters`, field: "goal" };
  if (!/[\p{L}\p{N}]/u.test(goal)) return { ok: false, error: "goal must describe an onchain outcome in words", field: "goal" };
  let walletAddress: string | undefined;
  const addresses = values(["walletAddress"]);
  if (addresses.length) {
    if (addresses.some((v) => typeof v !== "string" || !isAddress(v))) return { ok: false, error: "walletAddress must be a valid 0x address", field: "walletAddress" };
    if (new Set(addresses.map((v) => (v as string).toLowerCase())).size > 1) return { ok: false, error: "conflicting walletAddress values", field: "walletAddress" };
    walletAddress = (addresses[0] as string).toLowerCase();
  }
  return { ok: true, value: { goal, walletAddress } };
}


/** Demo wallet for callers that send no walletAddress. X Layer first (stablecoins and OKB), plus USDC and native gas on the other chains, so ordinary example goals are plannable. Not a real address. */
function aspDemoState() {
  const row = (chain: string, token: string, amount: number, decimals: number) => ({ chain, token, amount, tokenAddress: null, decimals, logo: null });
  return {
    address: "0xDEMO...WAYPOINT",
    balances: [
      row("xlayer", "USDC", 1000, 6), row("xlayer", "USD₮0", 1000, 6), row("xlayer", "USDG", 500, 6), row("xlayer", "OKB", 50, 18),
      ...CHAIN_KEYS.filter((c) => c !== "xlayer").flatMap((c) => [row(c, "USDC", 500, 6), row(c, getChain(c)!.nativeSymbol, c === "polygon" ? 500 : 1, 18)]),
    ],
  };
}

const PREPARED_TTL_MS = 15 * 60_000;
const MAX_PREPARED_PLANS = 500;

/** All fallible business work runs before the buyer is offered payment. */
async function preparePlan({ goal, walletAddress }: ParsedInput) {
  const state = walletAddress ? await getWalletState(walletAddress) : aspDemoState();
  const snapshot: WalletStateSnapshot = { ...state, label: "Selected wallet", kind: "execution" };
  const readiness = await judgeReadiness([], goal, [snapshot], [], process.env.OPENAI_MODEL || "gpt-4o-mini");
  if (!readiness.ready) {
    return { statusCode: 422, body: { ok: false, service: "Waypoint Plan", status: "needs_clarification", executed: false, charged: false, question: readiness.message } };
  }
  const parsed = await parseGoal(goal, [snapshot]);
  const plan = await buildPlan(parsed, [snapshot]);
  return {
    statusCode: 200,
    body: {
      ok: true,
      service: "Waypoint Plan",
      status: "planned",
      executed: false,
      walletState: walletAddress ? "onchain" : "demo",
      goal: parsed,
      plan,
      summary: prettyPlan(plan),
      preparedAt: new Date().toISOString(),
      note: "This is a plan only. Nothing was signed or sent. Execution requires the Waypoint app and a one-time user confirmation.",
    },
  };
}

type PreparedResult = { statusCode: number; body: Record<string, unknown> };

/** Separate factory keeps prepayment behavior testable without starting the app or its trigger monitor. */
export function createAspPlanHandlers(
  prepare: (input: ParsedInput) => Promise<PreparedResult> = preparePlan,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const perClient = new Map<string, number[]>();
  const globalHits: number[] = [];
  let inFlight = 0;
  const prepared = new Map<string, { expiresAt: number; json: string }>();
  const pending = new Map<string, Promise<PreparedResult>>();

  async function preCheck(req: Request, res: Response, next: NextFunction) {
    res.setHeader("Cache-Control", "no-store");
    const v = validateInput(req);
    if (!v.ok) { badInput(res, v.error, v.field); return; }
    const client = clientId(req);
    // Public, stateless planning depends on input, never the transport IP.
    // Marketplace probe and paid replay can use different egress servers.
    const key = JSON.stringify([v.value.goal, v.value.walletAddress ?? null]);
    const now = Date.now();
    for (const [k, entry] of prepared) if (entry.expiresAt <= now) prepared.delete(k);
    const cached = prepared.get(key);
    if (cached) {
      res.locals.aspCache = "hit";
      // An already prepared replay must not lose its result to a new rate limit,
      // changed chain state, or a concurrent customer's planning request.
      res.locals.aspPlanJson = cached.json;
      next();
      return;
    }
    try {
      let work = pending.get(key);
      if (!work) {
        if (inFlight >= MAX_CONCURRENT()) {
          res.setHeader("Retry-After", "10");
          res.status(429).json({ ok: false, charged: false, error: "service is busy, retry in a few seconds", retryAfterSeconds: 10 });
          return;
        }
        const wait = takeSlot(client, perClient, globalHits);
        if (wait !== null) {
          res.setHeader("Retry-After", String(wait));
          res.status(429).json({ ok: false, charged: false, error: "rate limit reached, retry later", retryAfterSeconds: wait });
          return;
        }
        inFlight++;
        // A timeout does not cancel upstream model/RPC work. Keep the concurrency
        // slot occupied until it actually finishes, and never cache a late result.
        const task = Promise.resolve().then(() => prepare(v.value)).finally(() => { inFlight--; });
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("planning timed out")), timeoutMs);
        });
        work = Promise.race([task, timeout]).finally(() => {
          clearTimeout(timer);
          pending.delete(key);
        });
        pending.set(key, work);
      }
      const result = await work;
      if (result.statusCode !== 200) {
        res.locals.aspFailure = result.body.status === "needs_clarification" ? "needs_clarification" : "preparation_rejected";
        res.status(result.statusCode).json(result.body);
        return;
      }
      // Serialize before payment too. Once x402 verifies the payment, delivering
      // this string requires no model, RPC, validation, or quota operations.
      const json = JSON.stringify(result.body);
      res.locals.aspCache = "prepared";
      if (prepared.size >= MAX_PREPARED_PLANS) prepared.delete(prepared.keys().next().value!);
      prepared.set(key, { expiresAt: Date.now() + PREPARED_TTL_MS, json });
      res.locals.aspPlanJson = json;
    } catch (err) {
      if (err instanceof PlanValidationError) {
        res.locals.aspFailure = "plan_validation";
        res.status(422).json({ ok: false, charged: false, error: err.message });
        return;
      }
      console.error("[asp/plan] preparation failed:", publicErrorMessage(err));
      const timedOut = err instanceof Error && err.message === "planning timed out";
      res.locals.aspFailure = timedOut ? "timeout" : "upstream_error";
      const upstreamBusy = /temporarily rate-limiting/.test(publicErrorMessage(err));
      res.status(timedOut ? 504 : upstreamBusy ? 503 : 500).json({
        ok: false,
        charged: false,
        error: timedOut ? "planning timed out" : upstreamBusy ? "an upstream data provider is busy, retry in a few seconds" : "planning failed, please retry",
      });
      return;
    }
    next();
  }

  function handlePlan(_req: Request, res: Response) {
    res.status(200).type("application/json").send(res.locals.aspPlanJson);
  }
  return { preCheck, handlePlan };
}

function registerPayment(app: Express): void {
  const payTo = PAY_TO();
  if (!payTo) return;
  if (!isAddress(payTo)) throw new Error("ASP_PAY_TO is not a valid 0x address");
  const { OKX_ONCHAIN_API_KEY: apiKey, OKX_ONCHAIN_SECRET_KEY: secretKey, OKX_ONCHAIN_PASSPHRASE: passphrase } = process.env;
  if (!apiKey || !secretKey || !passphrase) throw new Error("ASP_PAY_TO is set but the OKX_ONCHAIN_* facilitator credentials are missing");
  const facilitator = new OKXFacilitatorClient({ apiKey, secretKey, passphrase } as never);
  const network = PAY_NETWORK();
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  app.use(
    paymentMiddleware(
      {
        "POST /asp/plan": {
          resource: aspResourceUrl(),
          accepts: { scheme: "exact", price: `$${PRICE_USD()}`, network, payTo, maxTimeoutSeconds: 60 },
          description: "Waypoint Plan: one validated multi-step cross-chain execution plan (read-only)",
          mimeType: "application/json",
          extensions: { bazaar: ASP_DISCOVERY },
        },
      },
      server,
    ),
  );
  console.log(`[asp] x402 payment enabled: $${PRICE_USD()} per plan on ${network}, payTo ${payTo}`);
}

export function registerAspRoutes(app: Express): void {
  const { preCheck, handlePlan } = createAspPlanHandlers();
  app.use("/asp/plan", (req, res, next) => {
    const id = randomUUID();
    const started = Date.now();
    res.setHeader("X-Waypoint-Request-Id", id);
    res.on("finish", () => console.info("[asp/audit]", JSON.stringify({
      id, method: req.method, ...aspRequestAudit(req),
      status: res.statusCode, ms: Date.now() - started,
      cache: res.locals.aspCache ?? null, failure: res.locals.aspFailure ?? null,
      challenge: Boolean(res.getHeader("payment-required")),
      settlement: Boolean(res.getHeader("payment-response")),
    })));
    next();
  });
  app.post("/asp/plan", (req, res, next) => {
    if ((req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"])
      && !req.is("application/json") && !req.is("application/x-www-form-urlencoded")) {
      res.status(415).json({ ok: false, charged: false, error: "Use application/json or application/x-www-form-urlencoded" });
      return;
    }
    next();
  }, express.json(), express.urlencoded({ extended: false }), preCheck);
  registerPayment(app);
  app.get("/asp/plan", (_req, res) => res.status(200).json(DESCRIPTOR()));
  app.post("/asp/plan", handlePlan);
}
