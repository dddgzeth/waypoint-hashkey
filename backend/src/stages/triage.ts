import { triageIntent } from "../agents/triageAgent.js";
import { CONTINUE, type Stage } from "./types.js";

/** Does this turn need live balances at all, or can it be answered directly? */
export const triage: Stage = {
  id: "triage",
  async run(ctx) {
    ctx.hooks.onStage?.("triage");
    const result = await triageIntent(ctx.history, ctx.userText, ctx.wallets, ctx.modelFor("triage"));
    if (!result.needsWalletState) {
      return { done: true, result: { kind: "question", message: result.directAnswer ?? "Could you say more about what you'd like to do?" } };
    }
    return CONTINUE;
  },
};
