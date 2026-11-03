/**
 * The trading agent's rulebook: one typed config per agent, edited from chat. Every number here is
 * enforced by code (risk.ts), never by the model.
 */
import { z } from "zod";

export const ASSET_SYMBOLS = ["HSK", "ETH"] as const;
export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];

export const StrategyConfigSchema = z.object({
  /** "live" sends real transactions; "paper" fills at the live quote without sending anything. */
  mode: z.enum(["live", "paper"]),
  assets: z.array(z.enum(ASSET_SYMBOLS)).min(1),
  /** Largest single order, in USDT. */
  maxTradeUsd: z.number().positive(),
  /** Largest open position per asset, in USDT at cost. */
  maxPositionUsd: z.number().positive(),
  /** The agent stops opening positions for the day once the day's loss reaches this many USDT. */
  dailyLossLimitUsd: z.number().positive(),
  /** Buy when the pool trades at least this far below the reference price (percent). */
  entryDiscountPct: z.number().positive(),
  /** Close when the gap has narrowed to this (percent below reference). */
  exitDiscountPct: z.number(),
  /** Close a position that has lost this much from its average cost (percent). */
  stopLossPct: z.number().positive(),
  /** Close a position that has been open this long, whatever the price (hours). */
  maxHoldHours: z.number().positive(),
  /** Minutes to wait after a trade in the same asset. */
  cooldownMinutes: z.number().nonnegative(),
  /** Scales order size: low trades a third of maxTradeUsd, high trades all of it. */
  riskAppetite: z.enum(["low", "medium", "high"]),
  /** Asks the model to confirm each order. When false the rules decide alone. */
  useModel: z.boolean(),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export const DEFAULT_STRATEGY: StrategyConfig = {
  mode: "live",
  assets: ["HSK", "ETH"],
  maxTradeUsd: 25,
  maxPositionUsd: 100,
  dailyLossLimitUsd: 20,
  entryDiscountPct: 3,
  exitDiscountPct: 0.5,
  stopLossPct: 5,
  maxHoldHours: 12,
  cooldownMinutes: 30,
  riskAppetite: "medium",
  useModel: true,
};

export function withDefaults(partial: Partial<StrategyConfig> | undefined): StrategyConfig {
  return StrategyConfigSchema.parse({ ...DEFAULT_STRATEGY, ...(partial ?? {}) });
}

export function sizeFactor(risk: StrategyConfig["riskAppetite"]): number {
  return risk === "low" ? 1 / 3 : risk === "medium" ? 2 / 3 : 1;
}

export function describeStrategy(c: StrategyConfig): string {
  return (
    `${c.mode === "paper" ? "Paper" : "Live"} trading of ${c.assets.join(", ")} against USDT on HashKey Swap. ` +
    `Buys when the pool is ${c.entryDiscountPct}% or more below the reference price, closes at ${c.exitDiscountPct}% below it, ` +
    `stops out at -${c.stopLossPct}% or after ${c.maxHoldHours} hours. Orders up to ${c.maxTradeUsd} USDT, positions up to ${c.maxPositionUsd} USDT per asset, ` +
    `pauses for the day after a ${c.dailyLossLimitUsd} USDT loss. Risk appetite ${c.riskAppetite}.`
  );
}
