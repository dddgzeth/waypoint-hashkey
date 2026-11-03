/**
 * Cheap static checks run on agent-written Solidity before it is compiled.
 * They reject the constructs that make a generated contract unsafe to hold
 * funds regardless of what it is meant to do. This is a first filter, not an
 * audit: compilation, a simulated deployment and the audit pass in author.ts
 * follow it.
 */
export interface LintIssue {
  rule: string;
  message: string;
}

const MAX_SOURCE_CHARS = 60_000;

const RULES: Array<{ rule: string; pattern: RegExp; message: string }> = [
  { rule: "no-import", pattern: /^\s*import\s/m, message: "Imports are not available: the source must be self-contained (declare any interface you need inline)." },
  { rule: "no-selfdestruct", pattern: /\b(selfdestruct|suicide)\s*\(/, message: "selfdestruct is not allowed." },
  { rule: "no-delegatecall", pattern: /\bdelegatecall\b/, message: "delegatecall is not allowed." },
  { rule: "no-tx-origin", pattern: /\btx\.origin\b/, message: "tx.origin must not be used for authorization." },
];

export function lintSolidity(source: string): LintIssue[] {
  const issues: LintIssue[] = [];
  if (source.length > MAX_SOURCE_CHARS) issues.push({ rule: "size", message: `The source is longer than ${MAX_SOURCE_CHARS} characters.` });
  if (!/pragma\s+solidity/.test(source)) issues.push({ rule: "pragma", message: "Add a pragma solidity line (use ^0.8.24)." });
  // Strip comments so a forbidden word inside a comment does not trigger a rule.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const { rule, pattern, message } of RULES) {
    if (pattern.test(code)) issues.push({ rule, message });
  }
  return issues;
}
