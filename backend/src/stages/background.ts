import { runReviewPanel } from "../agents/reviewAgent.js";
import { getMemory } from "../memory/index.js";
import type { BackgroundStage } from "./types.js";

/** Learns from this turn for FUTURE turns; nothing it produces is shown now. */
export const memoryExtraction: BackgroundStage = {
  id: "memory",
  async run(ctx) {
    await getMemory().record(ctx.accountId, { userText: ctx.userText, assistantText: ctx.reply ?? "" }, ctx.modelFor("memory"));
  },
};

/** An independent model double-checks the goal and plan. Advisory logging only. */
export const review: BackgroundStage = {
  id: "review",
  async run(ctx) {
    const result = await runReviewPanel(ctx.goal!, ctx.plan!, ctx.states!, ctx.wallets);
    console.log("[review] goalMatch:", result.goalMatch, "feasibility:", result.feasibility);
  },
};
