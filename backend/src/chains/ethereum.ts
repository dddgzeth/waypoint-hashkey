import { mainnet } from "viem/chains";
import type { ChainConfig } from "./types.js";

export const ethereum: ChainConfig = {
  key: "ethereum",
  label: "Ethereum",
  chainId: 1,
  viemChain: mainnet,
  nativeSymbol: "ETH",
  // Verified live: getReserveData(USDC) on this pool returns a real non-zero aTokenAddress.
  aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  wrappedNative: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH" },
  alchemyNetwork: "eth-mainnet",
  cmcPlatform: "ethereum",
};
