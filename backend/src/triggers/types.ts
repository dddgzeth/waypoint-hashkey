import type { StrategyConfig } from "../hashkey/strategy.js";

/**
 * Completion condition — when a trigger should stop firing on its own,
 * independent of the user manually pausing it. Same four variants as Cobo
 * Agentic Wallet's Pact completion-condition schema (plan-finals-v2.md §3),
 * generalized across trigger types rather than each trigger type inventing
 * its own ad-hoc stop logic. Optional — a trigger with none runs indefinitely
 * until manually paused, which was the only behavior that existed before
 * this was added.
 */
export type CompletionCondition =
  | { type: "tx_count"; count: number }
  | { type: "usd_spent"; amountUsd: number }
  | { type: "token_amount_spent"; token: string; amount: number }
  | { type: "time_elapsed"; days: number };

/**
 * Trigger configs — one discriminated union covering every automation type
 * this account can register. Adding a new type means adding one more variant
 * here plus a case in monitor.ts's dispatch; nothing else needs to know the
 * shape (store.ts persists it as opaque JSON).
 */
export type TriggerConfig =
  | {
      type: "health_factor";
      chain: string;
      threshold: number;
      repayAsset: string;
      // A percent of the CURRENT debt at fire time, not a fixed token amount —
      // a fixed amount forces the user to hand-calculate how much they owe,
      // which is exactly the blind-fill friction this was built to remove.
      repayPercent: number;
      completionCondition: CompletionCondition | null;
    }
  | {
      type: "dca";
      chain: string;
      tokenIn: string;
      tokenOut: string;
      amountPerBuy: number;
      // Optional "HH:MM" UTC first-fire time. Omit it for an immediate first
      // purchase; this is a deliberate scheduling instruction, never a field
      // the caller has to invent just to create an interval DCA.
      timeOfDayUtc?: string;
      // Optional explicit delay before the first purchase. Mutually exclusive
      // with timeOfDayUtc; when both are omitted, the first purchase is now.
      startAfterMinutes?: number;
      // Optional rolling schedule. When present, the trigger fires this many
      // minutes after its previous successful execution instead of once per
      // UTC day. This makes DCA cadence an account-level choice, not a fixed
      // daily product assumption.
      intervalMinutes?: number;
      completionCondition: CompletionCondition | null;
    }
  | {
      type: "price_exit";
      chain: string;
      /** The position being protected: a contract address, or the chain's native symbol. */
      token: string;
      /** What the position is sold into (a stablecoin address). Prices are quoted in this token. */
      quoteToken: string;
      /** Sell when 1 `token` is worth this much `quoteToken` or less. */
      stopLossPrice?: number;
      /** Sell when 1 `token` is worth this much `quoteToken` or more. */
      takeProfitPrice?: number;
      /** A percent of the CURRENT holding at fire time, not a fixed amount. */
      sellPercent: number;
      completionCondition: CompletionCondition | null;
    }
  | {
      type: "hashkey_agent";
      chain: "hashkey";
      /** The whole rulebook of the HashKey trading agent (see hashkey/strategy.ts). */
      strategy: StrategyConfig;
      completionCondition: CompletionCondition | null;
    };

export type TriggerType = TriggerConfig["type"];

/** The asset a trigger spends, used by completion conditions. */
export function spentTokenOf(config: TriggerConfig): string {
  return config.type === "dca" ? config.tokenIn : config.type === "price_exit" ? config.token : config.type === "hashkey_agent" ? "USDT" : config.repayAsset;
}
