import { buildPlan } from "../planner.js";
import { publicErrorMessage } from "../errors.js";
import type { HighRiskStepWarning } from "../chat.js";
import type { ExecutionPlan } from "../models.js";
import { isAllowed } from "../customCall/allowlist.js";
import type { Stage } from "./types.js";

/** custom_call steps whose (target, function) pair isn't on this account's trusted list — needs explicit confirmation, not silent execution. */
export function findHighRiskSteps(accountId: string, plan: ExecutionPlan): HighRiskStepWarning[] {
  const warnings: HighRiskStepWarning[] = [];
  for (const step of plan.steps) {
    if (step.action !== "custom_call" || !step.customCallTarget || !step.customCallFunction) continue;
    // A contract this same plan deploys is the user's own creation, trusted by construction.
    if (/^deployed_by\(/.test(step.customCallTarget)) continue;
    if (!isAllowed(accountId, step.customCallTarget, step.customCallFunction)) {
      warnings.push({
        stepId: step.id,
        target: step.customCallTarget,
        functionSignature: step.customCallFunction,
        reason: "This calls a contract/method not on your trusted list yet. Review before confirming — confirming will trust it for future plans too.",
      });
    }
  }
  return warnings;
}

/** Builds the executable, validated plan. Ends the turn: with the plan, or with the reason none could be made. */
export const plan: Stage = {
  id: "planner",
  async run(ctx) {
    try {
      ctx.hooks.onStage?.("planning");
      ctx.plan = await buildPlan(ctx.goal!, ctx.states!, ctx.wallets, ctx.modelFor("planner"), ctx.memoryContext);
      return {
        done: true,
        result: {
          kind: "plan",
          message: ctx.reply!,
          goal: ctx.goal!,
          plan: ctx.plan,
          highRiskSteps: findHighRiskSteps(ctx.accountId, ctx.plan),
          ...(ctx.followUpAutomation ? { followUpAutomation: ctx.followUpAutomation } : {}),
        },
      };
    } catch (err) {
      return { done: true, result: { kind: "plan_failed", message: ctx.reply!, error: publicErrorMessage(err) } };
    }
  },
};
