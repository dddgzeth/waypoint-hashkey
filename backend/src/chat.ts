/**
 * Chat orchestration: runs one conversational turn through the stage pipeline
 * (stages/index.ts): triage, balances, readiness, automation intent, goal, plan.
 * A stage either lets the turn continue or ends it with a result: a question
 * for the user, an automation draft, or a plan. When a plan is produced, the
 * background stages (memory extraction, independent review) start without
 * delaying it. This file contains no agent logic; each stage owns its own.
 */
import type { Goal, ExecutionPlan, WalletStateSnapshot, WalletListEntry } from "./models.js";
import type { L0Turn } from "./memory/store.js";
import { getMemory } from "./memory/index.js";
import { modelFor } from "./llm.js";
import { PIPELINE, BACKGROUND, type TurnContext, type StageProgress } from "./stages/index.js";
import type { TriggerConfig } from "./triggers/types.js";

export interface HighRiskStepWarning {
  stepId: string;
  target: string;
  functionSignature: string;
  reason: string;
}

export type ChatTurnResult =
  | { kind: "question"; message: string }
  | { kind: "automation_draft"; message: string; automation: AutomationDraft }
  | {
      kind: "plan";
      message: string;
      goal: Goal;
      plan: ExecutionPlan;
      highRiskSteps: HighRiskStepWarning[];
      /** A standing rule the user asked for together with the plan; offered for confirmation once the plan has run. */
      followUpAutomation?: AutomationDraft;
    }
  | { kind: "plan_failed"; message: string; error: string };

/** A fully resolved but not-yet-active automation. The UI sends this back only
 * when the user performs the single final confirmation. */
export interface AutomationDraft {
  title: string;
  summary: string;
  sourceWalletAddress: string;
  sourceWalletLabel: string;
  config: TriggerConfig;
}

export async function runChatTurn(
  accountId: string,
  history: L0Turn[],
  userText: string,
  // Lazy — only invoked once triage decides this turn genuinely needs real
  // on-chain balances, instead of every single turn eagerly paying for a
  // multi-chain read + USD pricing before even knowing if it's relevant.
  getStates: () => Promise<WalletStateSnapshot[]>,
  wallets: WalletListEntry[],
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  // Fires right after the goal parser produces a structured Goal, before
  // planning starts — lets a caller (server.ts's /chat/stream) show the
  // parsed goal to the user as its own step.
  onGoal?: (goal: Goal) => void,
  // Fires right before getState() resolves, once triage has decided this
  // turn actually needs it.
  onReadingBalances?: (states: WalletStateSnapshot[]) => void | Promise<void>,
  // Fires right before each critical-path stage starts — real-time, purely informational.
  onStage?: (stage: StageProgress) => void
): Promise<ChatTurnResult> {
  const ctx: TurnContext = {
    accountId,
    history,
    userText,
    wallets,
    model,
    getStates,
    hooks: { onGoal, onReadingBalances, onStage },
    modelFor: (stageId) => modelFor(stageId, model),
    memoryContext: getMemory().recall(accountId, userText),
  };

  for (const stage of PIPELINE) {
    const outcome = await stage.run(ctx);
    if (!outcome.done) continue;
    if (outcome.result.kind === "plan") {
      // Fire-and-forget: none of these affects what this turn returns to the user (see stages/index.ts).
      for (const background of BACKGROUND) {
        background.run(ctx).catch((err) => console.error(`[${background.id}] failed:`, err instanceof Error ? err.message : err));
      }
    }
    return outcome.result;
  }
  return { kind: "question", message: "Could you say more about what you'd like to do?" };
}
