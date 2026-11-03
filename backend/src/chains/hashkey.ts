import { hashkey as viemHashkey } from "viem/chains";
import type { ChainConfig } from "./types.js";

// HashKey Chain (OP-stack L2, gas paid in HSK). Alchemy does not serve it, so every read and write goes
// through the public RPC, and balances come from the token list below (verified on hashkey.blockscout.com).
export const hashkey: ChainConfig = {
  key: "hashkey",
  label: "HashKey Chain",
  chainId: 177,
  viemChain: viemHashkey,
  nativeSymbol: "HSK",
  wrappedNative: { address: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", symbol: "WHSK" },
  publicRpc: "https://mainnet.hsk.xyz",
  knownTokens: [
    "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029", // USDT (6 decimals)
    "0x054ed45810DbBAb8B27668922D110669c9D88D0a", // USDC.e (6 decimals)
    "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", // WHSK
    "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0", // WETH
    "0x6119CA49a79f5825C8B345F8d7aC36B272565b14", // WBTC (8 decimals)
  ],
};

// HashKey Swap is a Uniswap V3 deployment (the main WHSK/USDT pool, 0.3%, is created by this factory).
export const HASHKEY_SWAP = {
  factory: "0x972cA9D1662F5e029cD18327D29026532E84c742",
  swapRouter02: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
  quoterV2: "0x1095A23A4812185344D9abd5143191D8a3A7E36f",
} as const;
