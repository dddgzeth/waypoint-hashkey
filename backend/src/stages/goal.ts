import { parseGoal } from "../goalParser.js";
import { CONTINUE, type Stage } from "./types.js";

/** Turns the conversation into a structured goal (what the user wants, not how to do it). */
export const goal: Stage = {
  id: "goal",
  async run(ctx) {
    ctx.hooks.onStage?.("parsing_goal");
    const conversationText = [...ctx.history.map((h) => `${h.role}: ${h.content}`), `user: ${ctx.immediateRequest ?? ctx.userText}`].join("\n");
    ctx.goal = await parseGoal(conversationText, ctx.states!, ctx.wallets, ctx.modelFor("goal"), ctx.memoryContext);
    ctx.hooks.onGoal?.(ctx.goal);
    return CONTINUE;
  },
};
