/**
 * Turns a market reading, the last day of prices and the open position into the opportunities worth acting on.
 * Entries must clear the round-trip cost (two pool fees, price impact, a safety buffer); exits are risk rules.
 */
import type { Reading } from "./market.js";
import type { Position } from "./ledger.js";
import type { StrategyConfig } from "./strategy.js";

export type SignalKind = "spread_entry" | "reversion_entry" | "exit_converged" | "exit_overshoot" | "exit_stop" | "exit_timeout";

export interface Signal {
  asset: Reading["asset"];
  kind: SignalKind;
  side: "buy" | "sell";
  /** Expected edge after costs for entries (percent); for exits, how far past the trigger. */
  edgePct: number;
  /** Exits that cut risk are carried out even if the model objects. */
  forced: boolean;
  detail: string;
}

export interface Stats {
  mean: number;
  std: number;
  z: number;
  points: number;
}

/** Mean, standard deviation and z-score of the pool price over the stored history. */
export function priceStats(prices: number[], now: number): Stats {
  if (prices.length < 12) return { mean: now, std: 0, z: 0, points: prices.length };
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
  const std = Math.sqrt(variance);
  return { mean, std, z: std > 0 ? (now - mean) / std : 0, points: prices.length };
}

/** A pool fee on each leg, plus a buffer for the price moving while the order confirms. */
export const POOL_FEE_PCT = 0.3;
const BUFFER_PCT = 0.5;

export function roundTripCostPct(impactPct: number): number {
  return 2 * POOL_FEE_PCT + 2 * impactPct + BUFFER_PCT;
}

export function findSignals(args: {
  reading: Reading;
  stats: Stats;
  position: Position | undefined;
  openedAt: number | null;
  config: StrategyConfig;
  impactPct: number;
  nowSec: number;
}): Signal[] {
  const { reading, stats, position, openedAt, config, impactPct, nowSec } = args;
  const out: Signal[] = [];
  const dev = reading.deviationPct;
  const cost = roundTripCostPct(impactPct);
  const holding = position && position.qty > 0;

  if (holding) {
    const lossPct = (reading.poolPrice / position.avgCost - 1) * 100;
    if (lossPct <= -config.stopLossPct) {
      out.push({ asset: reading.asset, kind: "exit_stop", side: "sell", edgePct: lossPct, forced: true, detail: `Down ${lossPct.toFixed(2)}% from the average cost, past the ${config.stopLossPct}% stop.` });
    }
    if (openedAt !== null && (nowSec - openedAt) / 3600 >= config.maxHoldHours) {
      out.push({ asset: reading.asset, kind: "exit_timeout", side: "sell", edgePct: lossPct, forced: true, detail: `Open for more than ${config.maxHoldHours} hours.` });
    }
    if (dev >= -config.exitDiscountPct) {
      out.push({ asset: reading.asset, kind: dev >= config.entryDiscountPct ? "exit_overshoot" : "exit_converged", side: "sell", edgePct: dev, forced: false, detail: `The pool is ${dev.toFixed(2)}% from the reference price, the gap has closed.` });
    }
  }

  if (dev <= -config.entryDiscountPct) {
    const edge = -dev - cost;
    if (edge > 0) {
      out.push({ asset: reading.asset, kind: "spread_entry", side: "buy", edgePct: edge, forced: false, detail: `Pool ${dev.toFixed(2)}% below the reference; ${edge.toFixed(2)}% left after ${cost.toFixed(2)}% of costs.` });
    }
  }
  if (stats.points >= 12 && stats.z <= -2 && dev < 0) {
    const reversion = ((stats.mean - reading.poolPrice) / reading.poolPrice) * 100;
    const edge = reversion - cost;
    if (edge > 0) {
      out.push({ asset: reading.asset, kind: "reversion_entry", side: "buy", edgePct: edge, forced: false, detail: `Price z-score ${stats.z.toFixed(2)} against its ${stats.points}-point day; ${reversion.toFixed(2)}% back to the mean, ${edge.toFixed(2)}% after costs.` });
    }
  }
  return out;
}
