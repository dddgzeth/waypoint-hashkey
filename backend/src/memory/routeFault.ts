/**
 * Whether a failure says something about the ROUTE (the provider could not quote it, the transaction reverted, the
 * delivery never arrived) rather than about the wallet or the environment (not enough funds or gas, a rate limit).
 * Only route faults count against a provider; otherwise one empty wallet would demote a healthy provider for everyone.
 */
const NOT_THE_ROUTES_FAULT = /insufficient funds|insufficient balance|exceeds balance|not enough|overshot|rate limit|too many requests|nonce too|no .* balance is available/i;

export function isRouteFault(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return !NOT_THE_ROUTES_FAULT.test(message);
}
