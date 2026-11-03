/**
 * The signer registry. To add a signer, write a module that implements
 * `Signer` and list it once in SIGNERS.
 */
import type { Account } from "viem";
import type { Signer } from "./types.js";
import { privySigner } from "./privy.js";
import { agenticWalletSigner } from "./agenticWallet.js";

export type { Signer, SignerWallet } from "./types.js";

const SIGNERS: Signer[] = [privySigner, agenticWalletSigner];
const BY_ID = new Map(SIGNERS.map((signer) => [signer.id, signer]));

export function allSigners(): readonly Signer[] {
  return SIGNERS;
}

export function getSigner(id: string): Signer | undefined {
  return BY_ID.get(id);
}

/** The account to sign and send with for a stored execution wallet. */
export function accountForWallet(wallet: { walletId: string; address: string; signer: string }): Account {
  const signer = getSigner(wallet.signer);
  if (!signer) throw new Error(`Unknown signer "${wallet.signer}" for wallet ${wallet.walletId}`);
  return signer.account(wallet);
}
