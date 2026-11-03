import { polygon as viemPolygon } from "viem/chains";
import type { ChainConfig } from "./types.js";

export const polygon: ChainConfig = {
  key: "polygon",
  label: "Polygon",
  chainId: 137,
  viemChain: viemPolygon,
  nativeSymbol: "POL",
  // Source: github.com/aave/aave-address-book AaveV3Polygon.sol — core Pool, not PoolAddressesProvider.
  // Same proxy address as Arbitrum/Base, verified real via Etherscan V2 (not assumed from the coincidence).
  aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  wrappedNative: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WPOL" },
  alchemyNetwork: "polygon-mainnet",
  cmcPlatform: "polygon",
};
