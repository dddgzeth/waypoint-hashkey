import { createPublicClient, encodeFunctionData, getAddress, http, parseUnits, type Hex } from "viem";
import { hashkey, HASHKEY_SWAP } from "../chains/hashkey.js";
import { resolveTokenReference, tokenReferenceDecimals } from "../tokenReference.js";
import type { RouteProvider } from "./types.js";

const WHSK = hashkey.wrappedNative!.address;
const FEES = [500, 3000, 10000] as const;

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const routerAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable", inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
] as const;

const client = createPublicClient({ chain: hashkey.viemChain, transport: http(hashkey.publicRpc) });

/** The best single-pool quote across HashKey Swap's fee tiers. A pool that does not exist just reverts, so it is skipped. */
async function bestQuote(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint) {
  const quotes = await Promise.all(
    FEES.map(async (fee) => {
      try {
        const { result } = await client.simulateContract({
          address: HASHKEY_SWAP.quoterV2,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        return { fee, amountOut: result[0] };
      } catch {
        return null;
      }
    })
  );
  const best = quotes.filter((q): q is { fee: (typeof FEES)[number]; amountOut: bigint } => q !== null && q.amountOut > 0n).sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];
  if (!best) throw new Error("No HashKey Swap pool with liquidity for this pair");
  return best;
}

/** What `amountIn` (raw units) of `tokenIn` buys of `tokenOut` right now, with the fee tier that gives the most. */
export async function quoteOut(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint): Promise<{ fee: number; amountOut: bigint }> {
  return bestQuote(getAddress(tokenIn), getAddress(tokenOut), amountIn);
}

/** What 1 `tokenIn` is worth in `tokenOut` right now, from HashKey Swap's own pools. */
export async function hashkeyPrice(tokenIn: `0x${string}`, tokenOut: `0x${string}`, decimalsIn: number, decimalsOut: number): Promise<number> {
  const { amountOut } = await bestQuote(getAddress(tokenIn), getAddress(tokenOut), parseUnits("1", decimalsIn));
  return Number(amountOut) / 10 ** decimalsOut;
}

/** Direct trades on HashKey Swap (Uniswap V3) through SwapRouter02: HashKey Chain is outside every aggregator's coverage. */
export const hashkeySwap: RouteProvider = {
  id: "hashkeyswap",
  kind: "swap",
  supports: (step) => step.chainFrom === "hashkey",
  priority: () => 0,
  async build({ step, amountIn, fromAddress, recipientAddress, outputTokenAddress, outputDecimals }) {
    const nativeIn = step.tokenIn.toUpperCase() === hashkey.nativeSymbol;
    const nativeOut = step.tokenOut.toUpperCase() === hashkey.nativeSymbol;
    const tokenIn = nativeIn ? WHSK : resolveTokenReference("hashkey", step.tokenIn);
    const tokenOut = nativeOut ? WHSK : resolveTokenReference("hashkey", step.tokenOut);
    if (!tokenIn || !tokenOut) throw new Error(`HashKey Swap needs a contract address or HSK; received ${step.tokenIn} -> ${step.tokenOut}`);

    const decimalsIn = await tokenReferenceDecimals("hashkey", nativeIn ? hashkey.nativeSymbol : step.tokenIn);
    const amount = parseUnits(String(amountIn), decimalsIn);
    const { fee, amountOut } = await bestQuote(getAddress(tokenIn), getAddress(tokenOut), amount);
    const slippageBps = BigInt(Math.round(Number(process.env.HASHKEY_SLIPPAGE_PERCENT ?? "1") * 100));
    const minOut = (amountOut * (10_000n - slippageBps)) / 10_000n;

    const swapCall = (recipient: `0x${string}`) =>
      encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [{ tokenIn: getAddress(tokenIn), tokenOut: getAddress(tokenOut), fee, recipient, amountIn: amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      });
    // Native out: swap into the router, then unwrap WHSK to the recipient in the same transaction.
    const data: Hex = nativeOut
      ? encodeFunctionData({
          abi: routerAbi,
          functionName: "multicall",
          args: [[swapCall(HASHKEY_SWAP.swapRouter02), encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minOut, recipientAddress] })]],
        })
      : swapCall(recipientAddress);

    return {
      tx: { to: HASHKEY_SWAP.swapRouter02, data, value: nativeIn ? (`0x${amount.toString(16)}` as `0x${string}`) : "0x0" },
      outputSymbol: step.tokenOut,
      outputTokenAddress: nativeOut ? null : outputTokenAddress,
      outputDecimals,
      approvalSpender: nativeIn ? undefined : HASHKEY_SWAP.swapRouter02,
    };
  },
};
