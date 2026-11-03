/**
 * Triage Agent — the first of Waypoint's real multi-agent pipeline (see
 * plan-finals-v2.md section "多 agent 设计"). Its one job: decide whether a
 * message genuinely needs Waypoint to read real, live on-chain balances
 * before it can be handled, or whether it's already answerable from what's
 * cheaply known (the account's wallet-label list, or general conversation
 * with no on-chain angle at all). Runs before every other agent in the
 * pipeline specifically so a plain question ("what's the address of X")
 * never pays for a multi-chain balance read it doesn't need.
 */
import { llm } from "../llm.js";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { WalletListEntry } from "../models.js";
import { describeWalletList } from "../models.js";
import type { L0Turn } from "../memory/store.js";

const TriageSchema = z.object({
  needsWalletState: z
    .boolean()
    .describe(
      "True only if answering this genuinely requires the user's real, live on-chain balances — " +
        "an execution goal (transfer/deposit/consolidate/swap/etc.), or a question about actual " +
        "holdings/value ('how much do I have', 'what's in my wallet'). False for anything answerable " +
        "from the known wallet list alone (e.g. resolving a wallet's label to its address) or general " +
        "conversation that isn't about on-chain assets at all."
    ),
  directAnswer: z
    .string()
    .nullable()
    .describe("If needsWalletState=false: your direct answer to the user. Null if needsWalletState=true."),
});
export type TriageResult = z.infer<typeof TriageSchema>;

const TRIAGE_SYSTEM_PROMPT = `You triage each message before Waypoint does anything expensive (reading real
balances across every chain the account holds assets on).

You're given the account's known wallets (label -> address) but NOT their live balances yet.

Set needsWalletState=true only if answering requires real-time on-chain data. Otherwise set it
false and answer directly in directAnswer.

Always set needsWalletState=true for anything about starting, tuning, pausing or stopping an automated
rule or trading agent (for example "start trading HSK on HashKey", "only trade ETH", "stop for the day
after losing 10 USDT", "switch to paper trading", DCA, stop-loss, take-profit, health-factor protection).
Those are handled by a later stage; never answer them or ask clarifying questions about them yourself.
Otherwise false is for — e.g. resolving a wallet's label to its address from
the list you were given, or a short reply to something that isn't about on-chain assets at all.`;

export async function triageIntent(
  history: L0Turn[],
  userText: string,
  wallets: WalletListEntry[],
  model: string
): Promise<TriageResult> {
  const openai = llm();
  const conversation = [...history.map((h) => `${h.role}: ${h.content}`), `user: ${userText}`].join("\n");

  const completion = await openai.beta.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: TRIAGE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${describeWalletList(wallets)}\n\nConversation so far:\n${conversation}`,
      },
    ],
    response_format: zodResponseFormat(TriageSchema, "triage"),
  });

  const parsed = completion.choices[0].message.parsed;
  if (!parsed) {
    throw new Error("Triage failed: the model did not return a parseable structured output");
  }
  return parsed;
}
