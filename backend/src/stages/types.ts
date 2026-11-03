/**
 * A stage is one step of the chat pipeline (triage, readiness, intent, planning ...).
 * The pipeline is the ordered list in ./index.ts; chat.ts only runs it. A stage
 * reads and fills the shared TurnContext, and either lets the turn continue or
 * ends it with a result (a question for the user, an automation draft, a plan).
 * Each stage picks its own model with ctx.modelFor(stage.id), so any stage can run
 * on a different model by setting STAGE_MODEL_<ID> (see llm.ts), without code changes.
 */
import type { ChatTurnResult, AutomationDraft } from "../chat.js";
import type { Goal, ExecutionPlan, WalletStateSnapshot, WalletListEntry } from "../models.js";
import type { L0Turn } from "../memory/store.js";

export type StageProgress = "triage" | "readiness" | "parsing_goal" | "parsing_automation" | "planning";

export interface TurnContext {
  accountId: string;
  history: L0Turn[];
  userText: string;
  wallets: WalletListEntry[];
  /** The default model for this turn; stages normally call modelFor(id) instead. */
  model: string;
  getStates(): Promise<WalletStateSnapshot[]>;
  hooks: {
    onGoal?: (goal: Goal) => void;
    onReadingBalances?: (states: WalletStateSnapshot[]) => void | Promise<void>;
    onStage?: (stage: StageProgress) => void;
  };
  modelFor(stageId: string): string;

  // Filled in as the turn progresses:
  memoryContext: string;
  states?: WalletStateSnapshot[];
  /** The assistant's reply once readiness decided there is enough to act on. */
  reply?: string;
  /** What the user wants done now, when the message also contained a standing rule. */
  immediateRequest?: string | null;
  followUpAutomation?: AutomationDraft;
  goal?: Goal;
  plan?: ExecutionPlan;
}

export type StageOutcome = { done: false } | { done: true; result: ChatTurnResult };

export interface Stage {
  id: string;
  run(ctx: TurnContext): Promise<StageOutcome>;
}

/** Work that follows a produced plan but must not delay it (review, memory extraction). Failures are logged, never shown. */
export interface BackgroundStage {
  id: string;
  run(ctx: TurnContext): Promise<void>;
}

export const CONTINUE: StageOutcome = { done: false };
