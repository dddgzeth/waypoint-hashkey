/**
 * The hard limits. The model can skip an order or shrink it; nothing it says can get past these checks.
 */
import type { PnlReport, Position } from "./ledger.js";
import type { StrategyConfig } from "./strategy.js";
import { sizeFactor } from "./strategy.js";

const MIN_ORDER_USD = 5;
/** An order may take at most this share of the pool's stablecoin side. */
const MAX_DEPTH_SHARE = 0.02;

export interface RiskVerdict {
  ok: boolean;
  /** The order size in USDT after every cap (buys only; sells always close the whole position). */
  usd: number;
  reasons: string[];
}

/** How much has been lost today (positive number), counting open positions at the live price. */
export function dayLossUsd(report: PnlReport): number {
  return Math.max(0, -(report.todayRealizedUsd + Math.min(0, report.unrealizedUsd)));
}

export function checkBuy(args: {
  config: StrategyConfig;
  position: Position | undefined;
  report: PnlReport;
  depthUsd: number;
  lastTradeSec: number | null;
  nowSec: number;
  walletUsdt: number | null;
}): RiskVerdict {
  const { config, position, report, depthUsd, lastTradeSec, nowSec, walletUsdt } = args;
  const reasons: string[] = [];
  if (dayLossUsd(report) >= config.dailyLossLimitUsd) {
    return { ok: false, usd: 0, reasons: [`Daily loss limit reached (${dayLossUsd(report).toFixed(2)} of ${config.dailyLossLimitUsd} USDT). No new positions today.`] };
  }
  if (lastTradeSec !== null && nowSec - lastTradeSec < config.cooldownMinutes * 60) {
    return { ok: false, usd: 0, reasons: [`In cooldown: last trade in this asset was ${Math.round((nowSec - lastTradeSec) / 60)} minutes ago, the pause is ${config.cooldownMinutes}.`] };
  }
  let usd = config.maxTradeUsd * sizeFactor(config.riskAppetite);
  const room = config.maxPositionUsd - (position?.costUsd ?? 0);
  if (room < MIN_ORDER_USD) return { ok: false, usd: 0, reasons: [`Position is at its ${config.maxPositionUsd} USDT cap.`] };
  if (usd > room) {
    usd = room;
    reasons.push(`Reduced to the ${config.maxPositionUsd} USDT position cap.`);
  }
  const depthCap = depthUsd * MAX_DEPTH_SHARE;
  if (usd > depthCap) {
    usd = depthCap;
    reasons.push(`Reduced to ${(MAX_DEPTH_SHARE * 100).toFixed(0)}% of the pool's depth.`);
  }
  if (walletUsdt !== null && usd > walletUsdt) {
    usd = walletUsdt;
    reasons.push(`Reduced to the wallet's ${walletUsdt.toFixed(2)} USDT.`);
  }
  if (usd < MIN_ORDER_USD) return { ok: false, usd: 0, reasons: [...reasons, `Order would be under ${MIN_ORDER_USD} USDT.`] };
  return { ok: true, usd: Math.floor(usd * 100) / 100, reasons };
}
