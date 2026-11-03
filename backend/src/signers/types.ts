/**
 * A signer is whatever holds the key for an execution wallet and puts its
 * transactions on-chain. The orchestrator only ever sees a viem Account: a
 * custodial signer returns an account that signs, a TEE signer returns an
 * account whose transactions are signed and broadcast by the service (see
 * ExternalSignerAccount in execution/shared.ts). Adding a signer means adding
 * a module here and listing it once in ./index.ts.
 */
import type { Account } from "viem";

export interface SignerWallet {
  walletId: string;
  address: string;
}

export interface Signer {
  id: string;
  label: string;
  /** custodial: a key the platform can use; tee: a key that never leaves a hardware enclave. */
  kind: "custodial" | "tee";
  /** Whether the user can export the private key (never true for a TEE wallet). */
  canExport: boolean;
  /** Whether this signer can be used on this deployment right now. */
  available(): Promise<boolean>;
  /** The account the orchestrator signs and sends with. */
  account(wallet: SignerWallet): Account;
}
