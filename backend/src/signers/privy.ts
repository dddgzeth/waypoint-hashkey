import { getExecutionAccount } from "../wallets/privy.js";
import type { Signer } from "./types.js";

/** Privy embedded server wallets owned by the platform's Authorization Key. */
export const privySigner: Signer = {
  id: "privy",
  label: "Waypoint execution wallet",
  kind: "custodial",
  canExport: true,
  available: async () => Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET),
  account: (wallet) => getExecutionAccount(wallet.walletId, wallet.address as `0x${string}`),
};
