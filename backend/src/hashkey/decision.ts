/**
 * The model's part: given the numbers for one candidate order, say go or no-go and how much of the
 * allowed size to use. It cannot change the asset or the side, and it cannot raise the size past what risk.ts allows.
 */
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { llm, modelFor } from "../llm.js";
import type { Reading } from "./market.js";
import type { Signal, Stats } from "./signals.js";
import type { StrategyConfig } from "./strategy.js";
import { describeStrategy } from "./strategy.js";

const DecisionSchema = z.object({
  decision: z.enum(["execute", "skip"]),
  sizeFraction: z.number().min(0).max(1).describe("Share of the allowed order size to use, 0 to 1."),
  rationale: z.string().describe("One or two sentences a trader would write in a log."),
});
export type Decision = z.infer<typeof DecisionSchema> & { source: "model" | "rules" };

const SYSTEM = `You are the decision step of an automated trading agent on HashKey Swap, a thin Uniswap V3 DEX on HashKey Chain.
Code has already found a signal, checked the costs and applied hard risk limits. You get the numbers for one candidate buy.
Decide whether to execute it and how much of the allowed size to use. Be a careful trader:
- A pool that sits below the market price only pays if it converges; a pool that has not moved in hours is a weaker signal than one that just moved.
- Net flow out of the pool (negative) means sellers are pushing the price down, which is a reason to size down; flow into the pool is supportive.
- A pool with no recent swaps is neutral, not bearish: stale pools are exactly where a gap to the market persists. Size down a little for it, but do not skip on that alone.
- Thin depth or a large price impact is a reason to size down.
- Skip when the evidence does not support the order: flow strongly out of the pool, impact that eats most of the edge, or a signal that contradicts the numbers. Never invent data that is not in the input.`;

export async function decideEntry(args: { config: StrategyConfig; reading: Reading; stats: Stats; signal: Signal; flow: { netUsdt: number; swaps: number }; impactPct: number; allowedUsd: number }): Promise<Decision> {
  const { config, reading, stats, signal, flow, impactPct, allowedUsd } = args;
  if (!config.useModel || !process.env.OPENAI_API_KEY) {
    return { decision: "execute", sizeFraction: 1, rationale: `Rules only: ${signal.detail}`, source: "rules" };
  }
  try {
    const completion = await llm().beta.chat.completions.parse({
      model: modelFor("hashkey_agent", process.env.OPENAI_MODEL || "gpt-4o-mini"),
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: JSON.stringify(
            {
              strategy: describeStrategy(config),
              asset: reading.asset,
              poolPriceUsdt: reading.poolPrice,
              referencePriceUsd: reading.refPrice,
              deviationPct: Number(reading.deviationPct.toFixed(3)),
              poolDepthUsdt: Math.round(reading.depthUsd),
              dayStats: { points: stats.points, mean: stats.mean, std: stats.std, zScore: Number(stats.z.toFixed(2)) },
              lastHourFlow: { netUsdtIntoPool: Number(flow.netUsdt.toFixed(2)), swaps: flow.swaps },
              estimatedImpactPct: Number(impactPct.toFixed(3)),
              signal: { kind: signal.kind, edgePctAfterCosts: Number(signal.edgePct.toFixed(3)), detail: signal.detail },
              allowedOrderUsdt: allowedUsd,
            },
            null,
            1
          ),
        },
      ],
      response_format: zodResponseFormat(DecisionSchema, "trade_decision"),
    });
    const parsed = completion.choices[0].message.parsed;
    if (!parsed) throw new Error("no parsed decision");
    return { ...parsed, source: "model" };
  } catch (err) {
    return { decision: "execute", sizeFraction: 1, rationale: `Model unavailable (${err instanceof Error ? err.message.slice(0, 80) : "error"}); rules decided: ${signal.detail}`, source: "rules" };
  }
}
