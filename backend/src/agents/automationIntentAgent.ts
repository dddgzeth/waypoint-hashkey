/**
 * Automation intent agent. It recognizes durable, self-running requests in
 * chat and turns them into a typed draft. A draft is deliberately not a
 * trigger: the user gets one final confirmation before it can make any
 * on-chain transaction or start monitoring a position.
 */
import { llm } from "../llm.js";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { WalletListEntry, WalletStateSnapshot } from "../models.js";
import { describeWalletList, describeWalletStates } from "../models.js";
import type { L0Turn } from "../memory/store.js";

const AutomationIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("incomplete"),
    automationType: z.enum(["dca", "health_factor", "price_exit", "hashkey_agent"]),
    question: z.string(),
  }),
  z.object({
    kind: z.literal("dca"),
    chain: z.string(),
    tokenIn: z.string(),
    tokenOut: z.string(),
    amountPerBuy: z.number(),
    intervalMinutes: z.number().int().positive().nullable(),
    timeOfDayUtc: z.string().nullable(),
    startAfterMinutes: z.number().int().positive().nullable(),
    executionCount: z.number().int().positive().nullable(),
    sourceWalletLabel: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("health_factor"),
    chain: z.string(),
    threshold: z.number().positive(),
    repayAsset: z.string(),
    repayPercent: z.number().positive().max(100),
    executionCount: z.number().int().positive().nullable(),
    sourceWalletLabel: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("hashkey_agent"),
    sourceWalletLabel: z.string().nullable(),
    mode: z.enum(["live", "paper"]).nullable(),
    assets: z.array(z.enum(["HSK", "ETH"])).nullable(),
    maxTradeUsd: z.number().positive().nullable(),
    maxPositionUsd: z.number().positive().nullable(),
    dailyLossLimitUsd: z.number().positive().nullable(),
    entryDiscountPct: z.number().positive().nullable(),
    stopLossPct: z.number().positive().nullable(),
    maxHoldHours: z.number().positive().nullable(),
    cooldownMinutes: z.number().nonnegative().nullable(),
    riskAppetite: z.enum(["low", "medium", "high"]).nullable(),
  }),
  z.object({
    kind: z.literal("price_exit"),
    chain: z.string(),
    token: z.string(),
    quoteToken: z.string(),
    stopLossPrice: z.number().positive().nullable(),
    takeProfitPrice: z.number().positive().nullable(),
    sellPercent: z.number().positive().max(100),
    executionCount: z.number().int().positive().nullable(),
    sourceWalletLabel: z.string().nullable(),
  }),
]);

export type AutomationIntent = z.infer<typeof AutomationIntentSchema>;
const AutomationIntentResponseSchema = z.object({
  intent: AutomationIntentSchema,
  immediateRequest: z
    .string()
    .nullable()
    .describe(
      "Only when the message ALSO asks for actions to carry out right now (for example supplying collateral or borrowing before arming a rule): those actions restated as a standalone request, without the automation rule. Null when there is nothing else to do now."
    ),
});

export interface ParsedAutomationIntent {
  intent: AutomationIntent;
  /** What the user also wants done immediately, separate from the standing rule. */
  immediateRequest: string | null;
}

const SYSTEM_PROMPT = `You are Waypoint's automation-intent agent.
Recognize only requests that should keep running without the user returning:
- DCA / recurring purchase / scheduled periodic swap.
- A health-factor safety rule that repays debt when a threshold is crossed.
- A price exit: a stop-loss and/or take-profit that sells a position into a stablecoin when its price crosses a bound
  (for example "sell my HSK into USDT if it drops to 0.07 or rises to 0.12"). Prices are in quoteToken per 1 token.
  Set sellPercent to 100 when the user says to sell the whole position or does not give a share. At least one of
  stopLossPrice and takeProfitPrice is required; ask for it with kind="incomplete" if neither is given.
- Starting, or changing the settings of, the autonomous trading agent on HashKey Chain: it watches HashKey Swap, buys
  HSK or ETH when a pool trades cheap against the market, sells when the gap closes, and keeps its own stop-loss,
  position caps and daily loss limit. Examples: "start trading HSK and ETH on HashKey, 20 USDT per trade, low risk",
  "only trade ETH", "stop opening positions after losing 10 USDT in a day", "switch to paper trading", "be more
  aggressive". Fill only the fields the user mentioned. Every field the user did not state must be null, never 0 and never a
  guess: null keeps the agent's current setting. stopLossPct and the like are set only when the user
  talks about when to close or stop out. HSK is the native token of HashKey Chain, so a request about HSK needs no
  chain question.
  "Low risk" means riskAppetite low; "aggressive" means high. Use this, not price_exit, when the user wants the agent to
  decide trades; use price_exit only for a sale at a price the user names.

Return kind="none" for a one-off swap, transfer, deposit, withdrawal, or any
ordinary execution goal. Do not invent a schedule, a token, an amount, a
chain, or a wallet. For an automation request that is missing an indispensable
field, return kind="incomplete" with exactly one short question. For DCA,
intervalMinutes is required unless the user specified a daily UTC clock time.
Use a contract address exactly as supplied when the user names an arbitrary
ERC-20. executionCount is the requested number of successful on-chain actions:
successful purchases for DCA, successful repayments for a health-factor
rule, or successful sales for a price exit. Set it whenever the user says to stop after a number of confirmed
actions. Omit timeOfDayUtc and startAfterMinutes unless explicitly requested:
a DCA starts with an immediate first purchase by default.

A message can mix one-off actions with a standing rule, for example "supply 1 ETH as collateral, borrow 1,000 USDC,
then repay half the debt automatically if the health factor drops below 1.5". Return the standing rule as the intent
and put the one-off actions, restated as their own request, in immediateRequest. Leave immediateRequest null when the
message is only the standing rule.`;

export async function parseAutomationIntent(
  history: L0Turn[],
  userText: string,
  states: WalletStateSnapshot[],
  wallets: WalletListEntry[],
  model: string,
  hasHashkeyAgent = false
): Promise<ParsedAutomationIntent> {
  const agentNote = hasHashkeyAgent
    ? "\n\nThis account already runs the HashKey trading agent. Any message that changes its mode (paper/live), assets, order size, position cap, daily loss limit, stop-loss, hold time, cooldown or risk level, or that says to stop opening positions for the day, is a hashkey_agent settings change, even when the message never says \"agent\"."
    : "";
  const conversation = [...history.map((turn) => `${turn.role}: ${turn.content}`), `user: ${userText}`].join("\n");
  const completion = await llm().beta.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Selected chat wallet is first in the state list.\n\n${describeWalletStates(states)}\n\n${describeWalletList(wallets)}\n\nConversation:\n${conversation}${agentNote}`,
      },
    ],
    response_format: zodResponseFormat(AutomationIntentResponseSchema, "automation_intent"),
  });
  const parsed = completion.choices[0].message.parsed;
  if (!parsed) throw new Error("Automation intent parsing failed: the model did not return a parseable result");
  return { intent: parsed.intent, immediateRequest: parsed.immediateRequest?.trim() || null };
}
