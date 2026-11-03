import { CONTINUE, type Stage } from "./types.js";

/** Reads the live balances, once triage decided they are needed. Not an agent: no model call. */
export const balances: Stage = {
  id: "balances",
  async run(ctx) {
    ctx.states = await ctx.getStates();
    await ctx.hooks.onReadingBalances?.(ctx.states);
    return CONTINUE;
  },
};
