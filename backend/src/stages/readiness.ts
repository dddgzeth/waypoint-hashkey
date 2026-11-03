import { judgeReadiness } from "../agents/readinessAgent.js";
import { CONTINUE, type Stage } from "./types.js";

/** Is there enough information to act yet? If not, ask one question. */
export const readiness: Stage = {
  id: "readiness",
  async run(ctx) {
    ctx.hooks.onStage?.("readiness");
    const decision = await judgeReadiness(ctx.history, ctx.userText, ctx.states!, ctx.wallets, ctx.modelFor("readiness"));
    if (!decision.ready) {
      // A clarifying question doesn't carry much durable signal — extraction runs
      // on plan-producing turns, where the user has actually stated something concrete.
      return { done: true, result: { kind: "question", message: decision.message } };
    }
    ctx.reply = decision.message;
    return CONTINUE;
  },
};
