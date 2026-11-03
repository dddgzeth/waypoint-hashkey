/**
 * The chat pipeline. To add, remove or reorder a stage, edit these two lists:
 * chat.ts runs PIPELINE in order until a stage ends the turn, then starts
 * BACKGROUND without waiting for it.
 */
import type { BackgroundStage, Stage } from "./types.js";
import { triage } from "./triage.js";
import { balances } from "./balances.js";
import { readiness } from "./readiness.js";
import { automationIntent } from "./automation.js";
import { goal } from "./goal.js";
import { plan } from "./plan.js";
import { memoryExtraction, review } from "./background.js";

export type { Stage, BackgroundStage, TurnContext, StageOutcome, StageProgress } from "./types.js";

export const PIPELINE: Stage[] = [triage, balances, readiness, automationIntent, goal, plan];
export const BACKGROUND: BackgroundStage[] = [memoryExtraction, review];
