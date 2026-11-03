import { parseAutomationIntent, type AutomationIntent } from "../agents/automationIntentAgent.js";
import { CHAINS } from "../chains/index.js";
import type { AutomationDraft } from "../chat.js";
import type { WalletStateSnapshot } from "../models.js";
import { isContractTokenReference, resolveTokenReference } from "../tokenReference.js";
import { NATIVE_PLACEHOLDER_ZERO } from "../tokenRegistry.js";
import type { TriggerConfig } from "../triggers/types.js";
import { CONTINUE, type Stage } from "./types.js";
import { listTriggersForAccount } from "../triggers/store.js";
import { describeStrategy, withDefaults } from "../hashkey/strategy.js";

const HASHKEY_TOKEN_BY_SYMBOL: Record<string, string> = {
  USDT: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
  "USDC.E": "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
  USDC: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
  WHSK: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
  WETH: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
  WBTC: "0x6119CA49a79f5825C8B345F8d7aC36B272565b14",
};

function normalizedChain(input: string): string {
  const chain = input.trim().toLowerCase();
  if (!CHAINS[chain]) throw new Error(`${input} is not a supported Waypoint chain`);
  return chain;
}

function resolveAutomationWallet(
  sourceWalletLabel: string | null,
  states: WalletStateSnapshot[]
): WalletStateSnapshot {
  if (!sourceWalletLabel) return states[0];
  const wallet = states.find((state) => state.label.toLowerCase() === sourceWalletLabel.trim().toLowerCase());
  if (!wallet) throw new Error(`I couldn't find execution wallet “${sourceWalletLabel}”. Choose one of the execution wallets shown in chat.`);
  return wallet;
}

function tryResolveWallet(label: string | null, states: WalletStateSnapshot[]): WalletStateSnapshot {
  try {
    return resolveAutomationWallet(label, states);
  } catch {
    return states[0];
  }
}

/** Resolve a chat token reference without a curated token map. Contract
 * addresses are canonical; a symbol is allowed only when it is present in
 * this execution wallet's live state on that chain (or is the chain native). */
function resolveAutomationToken(chain: string, reference: string, wallet: WalletStateSnapshot, role: "funding" | "target"): string {
  const trimmed = reference.trim();
  if (isContractTokenReference(trimmed)) return resolveTokenReference(chain, trimmed, NATIVE_PLACEHOLDER_ZERO)!;
  const native = CHAINS[chain].nativeSymbol;
  if (trimmed.toUpperCase() === native.toUpperCase()) return native;
  // HashKey Chain's main tokens have fixed, verified addresses: no need for the wallet to hold them already.
  const known = chain === "hashkey" ? HASHKEY_TOKEN_BY_SYMBOL[trimmed.toUpperCase()] : undefined;
  if (known) return known;
  const holding = wallet.balances.find(
    (balance) => balance.chain === chain && balance.token.toLowerCase() === trimmed.toLowerCase() && balance.tokenAddress
  );
  if (holding?.tokenAddress) return holding.tokenAddress;
  const suffix = role === "target" ? " Please give its ERC-20 contract address." : " Choose an asset visible in this wallet's live balances or give its contract address.";
  throw new Error(`I can't safely resolve ${trimmed} on ${chain} from on-chain data.${suffix}`);
}

function draftAutomation(intent: Exclude<AutomationIntent, { kind: "none" | "incomplete" }>, states: WalletStateSnapshot[], accountId: string): AutomationDraft {
  // Trading-agent settings talk about "the agent", not a wallet: an unreadable label falls back to the wallet selected in chat.
  const wallet = intent.kind === "hashkey_agent" ? tryResolveWallet(intent.sourceWalletLabel, states) : resolveAutomationWallet(intent.sourceWalletLabel, states);
  if (intent.kind === "hashkey_agent") {
    // Only what the user mentioned changes; everything else stays as the wallet's current agent has it.
    const current = listTriggersForAccount(accountId).find((t) => t.triggerType === "hashkey_agent" && t.config.type === "hashkey_agent");
    const base = current && current.config.type === "hashkey_agent" ? current.config.strategy : undefined;
    const changes = Object.fromEntries(
      Object.entries({
        mode: intent.mode, assets: intent.assets, maxTradeUsd: intent.maxTradeUsd, maxPositionUsd: intent.maxPositionUsd, dailyLossLimitUsd: intent.dailyLossLimitUsd,
        entryDiscountPct: intent.entryDiscountPct, stopLossPct: intent.stopLossPct, maxHoldHours: intent.maxHoldHours,
        cooldownMinutes: intent.cooldownMinutes, riskAppetite: intent.riskAppetite,
      }).filter(([, v]) => v !== null && v !== undefined)
    );
    const strategy = withDefaults({ ...(base ?? {}), ...changes } as never);
    if (strategy.exitDiscountPct >= strategy.entryDiscountPct) throw new Error("The exit gap has to be smaller than the entry gap, otherwise the agent would sell the moment it buys.");
    const config: TriggerConfig = { type: "hashkey_agent", chain: "hashkey", strategy, completionCondition: null };
    return {
      title: base ? "Trading agent settings" : "HashKey trading agent",
      summary: `${describeStrategy(strategy)} ${base ? "Only the settings you mentioned change; its positions and history stay." : "It checks every minute, trades on its own inside these limits, and reports each fill here."}`,
      sourceWalletAddress: wallet.address,
      sourceWalletLabel: wallet.label,
      config,
    };
  }
  const chain = normalizedChain(intent.chain);
  if (intent.kind === "dca") {
    if (!intent.intervalMinutes && !intent.timeOfDayUtc) throw new Error("For a DCA automation, tell me how often it should buy (for example, every 3 minutes or daily at 09:00 UTC).");
    if (intent.startAfterMinutes && intent.timeOfDayUtc) throw new Error("Choose either a first-run delay or a UTC start time, not both.");
    const tokenIn = resolveAutomationToken(chain, intent.tokenIn, wallet, "funding");
    const tokenOut = resolveAutomationToken(chain, intent.tokenOut, wallet, "target");
    const completionCondition = intent.executionCount ? { type: "tx_count" as const, count: intent.executionCount } : null;
    const config: TriggerConfig = {
      type: "dca",
      chain,
      tokenIn,
      tokenOut,
      amountPerBuy: intent.amountPerBuy,
      ...(intent.intervalMinutes ? { intervalMinutes: intent.intervalMinutes } : {}),
      ...(intent.timeOfDayUtc ? { timeOfDayUtc: intent.timeOfDayUtc } : {}),
      ...(intent.startAfterMinutes ? { startAfterMinutes: intent.startAfterMinutes } : {}),
      completionCondition,
    };
    const cadence = intent.intervalMinutes ? `every ${intent.intervalMinutes} minutes` : `daily at ${intent.timeOfDayUtc} UTC`;
    const limit = intent.executionCount ? `, stopping after ${intent.executionCount} confirmed purchases` : "";
    return {
      title: "DCA buy",
      summary: `${intent.amountPerBuy} ${intent.tokenIn} → ${intent.tokenOut} on ${chain}, ${cadence}${limit}. First purchase is immediate unless a start time or delay was specified.`,
      sourceWalletAddress: wallet.address,
      sourceWalletLabel: wallet.label,
      config,
    };
  }
  if (intent.kind === "price_exit") {
    if (intent.stopLossPrice === null && intent.takeProfitPrice === null) throw new Error("Tell me the price to sell at: a stop-loss, a take-profit, or both.");
    const token = resolveAutomationToken(chain, intent.token, wallet, "funding");
    const quoteToken = resolveAutomationToken(chain, intent.quoteToken, wallet, "target");
    const config: TriggerConfig = {
      type: "price_exit",
      chain,
      token,
      quoteToken,
      ...(intent.stopLossPrice !== null ? { stopLossPrice: intent.stopLossPrice } : {}),
      ...(intent.takeProfitPrice !== null ? { takeProfitPrice: intent.takeProfitPrice } : {}),
      sellPercent: intent.sellPercent,
      completionCondition: intent.executionCount ? { type: "tx_count", count: intent.executionCount } : { type: "tx_count", count: 1 },
    };
    const bounds = [
      intent.stopLossPrice !== null ? `falls to ${intent.stopLossPrice}` : null,
      intent.takeProfitPrice !== null ? `rises to ${intent.takeProfitPrice}` : null,
    ].filter(Boolean).join(" or ");
    return {
      title: "Stop-loss / take-profit",
      summary: `On ${chain}, sell ${intent.sellPercent}% of ${intent.token} into ${intent.quoteToken} when its price ${bounds} (${intent.quoteToken} per ${intent.token}). Checked every minute from HashKey Swap's own pools; stops after ${intent.executionCount ?? 1} confirmed sale${(intent.executionCount ?? 1) === 1 ? "" : "s"}.`,
      sourceWalletAddress: wallet.address,
      sourceWalletLabel: wallet.label,
      config,
    };
  }
  const repayAsset = resolveAutomationToken(chain, intent.repayAsset, wallet, "funding");
  const config: TriggerConfig = {
    type: "health_factor",
    chain,
    threshold: intent.threshold,
    repayAsset,
    repayPercent: intent.repayPercent,
    completionCondition: intent.executionCount ? { type: "tx_count", count: intent.executionCount } : null,
  };
  const limit = intent.executionCount ? ` Stop after ${intent.executionCount} confirmed repayment${intent.executionCount === 1 ? "" : "s"}.` : "";
  return {
    title: "Health-factor repayment",
    summary: `On ${chain}, repay ${intent.repayPercent}% of ${intent.repayAsset} debt whenever health factor falls below ${intent.threshold}.${limit}`,
    sourceWalletAddress: wallet.address,
    sourceWalletLabel: wallet.label,
    config,
  };
}

/** Is this a standing rule (DCA, health-factor repay)? Drafts it for one confirmation, or hands the one-off part on to planning. */
export const automationIntent: Stage = {
  id: "automation",
  async run(ctx) {
    ctx.hooks.onStage?.("parsing_automation");
    const { intent, immediateRequest } = await parseAutomationIntent(
      ctx.history, ctx.userText, ctx.states!, ctx.wallets, ctx.modelFor("automation"),
      listTriggersForAccount(ctx.accountId).some((t) => t.triggerType === "hashkey_agent")
    );
    if (intent.kind === "incomplete") return { done: true, result: { kind: "question", message: intent.question } };
    if (intent.kind === "none") return CONTINUE;
    try {
      const automation = draftAutomation(intent, ctx.states!, ctx.accountId);
      if (!immediateRequest) {
        return {
          done: true,
          result: { kind: "automation_draft", message: "I turned that recurring/conditional request into an automation. Review it once; after confirmation it will appear in Automations and run on its own.", automation },
        };
      }
      // The message mixes one-off actions with a standing rule: plan the actions now and offer the rule once they have run.
      ctx.immediateRequest = immediateRequest;
      ctx.followUpAutomation = automation;
      return CONTINUE;
    } catch (err) {
      return { done: true, result: { kind: "question", message: err instanceof Error ? err.message : String(err) } };
    }
  },
};
