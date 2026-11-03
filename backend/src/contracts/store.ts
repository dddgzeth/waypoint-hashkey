/**
 * Contracts the agent has deployed for an account. Recording them lets the
 * user see what was deployed and from what source, and trusting every function
 * of a contract the account's own plan deployed means later plans can call it
 * without a per-call confirmation (see customCall/allowlist.ts).
 */
import type { Abi } from "viem";
import { getDb } from "../accounts/store.js";
import { trust, TRUST_ALL_FUNCTIONS } from "../customCall/allowlist.js";

let initialized = false;
function ensureSchema(): void {
  if (initialized) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS deployed_contracts (
      account_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      abi TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, chain, address)
    );
  `);
  initialized = true;
}

export interface DeployedContractRecord {
  chain: string;
  address: string;
  name: string;
  source: string;
  abi: Abi;
  txHash: string;
}

/** Stores the deployment and trusts the whole contract for this account. */
export function recordDeployment(accountId: string, record: DeployedContractRecord): void {
  ensureSchema();
  getDb()
    .prepare(
      `INSERT INTO deployed_contracts (account_id, chain, address, name, source, abi, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, chain, address) DO NOTHING`
    )
    .run(accountId, record.chain, record.address.toLowerCase(), record.name, record.source, JSON.stringify(record.abi), record.txHash, new Date().toISOString());
  trust(accountId, record.address, TRUST_ALL_FUNCTIONS);
}

export function listDeployments(accountId: string): Array<Omit<DeployedContractRecord, "abi"> & { createdAt: string }> {
  ensureSchema();
  const rows = getDb()
    .prepare(`SELECT chain, address, name, source, tx_hash, created_at FROM deployed_contracts WHERE account_id = ? ORDER BY created_at DESC`)
    .all(accountId) as Array<{ chain: string; address: string; name: string; source: string; tx_hash: string; created_at: string }>;
  return rows.map((r) => ({ chain: r.chain, address: r.address, name: r.name, source: r.source, txHash: r.tx_hash, createdAt: r.created_at }));
}
