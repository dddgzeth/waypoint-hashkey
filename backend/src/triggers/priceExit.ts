/**
 * Price exit (stop-loss / take-profit) — the action a "price_exit" trigger
 * takes. Reads the live price from HashKey Swap's own pools, and when it
 * crosses a bound sells a percent of the current holding into the quote
 * token through the same runPlan() pipeline a chat plan uses (simulation
 * before sending, real output measured from the receipt).
 */
import { createPublicClient, erc20Abi, getAddress, http } from "viem";
import type { Account } from "viem";
import { hashkey } from "../chains/hashkey.js";
import { hashkeyPrice } from "../providers/hashkeyswap.js";
import type { StepResult } from "../orchestrator.js";
import { swapOnHashkey } from "../hashkey/exec.js";
import { tokenReferenceDecimals } from "../tokenReference.js";
import type { TriggerConfig } from "./types.js";

type PriceExit = Extract<TriggerConfig, { type: "price_exit" }>;

/** HSK kept back when the protected position is the gas token itself. */
const NATIVE_GAS_RESERVE = Number(process.env.HASHKEY_GAS_RESERVE_HSK ?? 1);

const client = createPublicClient({ chain: hashkey.viemChain, transport: http(hashkey.publicRpc) });

function isNative(token: string): boolean {
  return token.toUpperCase() === hashkey.nativeSymbol;
}

export interface PriceReading {
  price: number;
  /** "stop_loss" or "take_profit" when a bound is crossed, otherwise null. */
  breach: "stop_loss" | "take_profit" | null;
}

export async function readPriceExit(config: PriceExit): Promise<PriceReading> {
  if (config.chain !== "hashkey") throw new Error("price_exit currently reads prices from HashKey Swap, so it is available on hashkey only");
  const tokenIn = isNative(config.token) ? hashkey.wrappedNative!.address : (config.token as `0x${string}`);
  const [decimalsIn, decimalsOut] = await Promise.all([
    tokenReferenceDecimals("hashkey", config.token),
    tokenReferenceDecimals("hashkey", config.quoteToken),
  ]);
  const price = await hashkeyPrice(tokenIn, config.quoteToken as `0x${string}`, decimalsIn, decimalsOut);
  const breach =
    config.stopLossPrice !== undefined && price <= config.stopLossPrice
      ? "stop_loss"
      : config.takeProfitPrice !== undefined && price >= config.takeProfitPrice
        ? "take_profit"
        : null;
  return { price, breach };
}

/** The amount to sell: sellPercent of the holding, keeping a gas reserve when the holding is native HSK. */
export async function sellAmount(config: PriceExit, owner: `0x${string}`): Promise<number> {
  const decimals = await tokenReferenceDecimals("hashkey", config.token);
  const raw = isNative(config.token)
    ? await client.getBalance({ address: owner })
    : await client.readContract({ address: getAddress(config.token), abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  const holding = Number(raw) / 10 ** decimals;
  const available = isNative(config.token) ? Math.max(0, holding - NATIVE_GAS_RESERVE) : holding;
  return Math.floor(available * (config.sellPercent / 100) * 10 ** 6) / 10 ** 6;
}

export async function runPriceExit(config: PriceExit, account: Account, amount: number): Promise<StepResult> {
  return swapOnHashkey(account, config.token, config.quoteToken, amount, `Price exit: sell ${amount} ${config.token} into ${config.quoteToken} on ${config.chain}`);
}
