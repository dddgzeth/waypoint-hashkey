/**
 * Contract-authoring stage: turns the planner's description of a contract into
 * audited, compilable Solidity. The agent writes the contract (the user is not
 * expected to know Solidity); everything it writes passes the same gates before
 * it can reach a plan:
 *
 *   1. static lint (no imports, selfdestruct, delegatecall, tx.origin)
 *   2. compilation with the pinned compiler
 *   3. every external function a later plan step calls actually exists in the ABI
 *   4. an independent audit pass that looks for ways funds could be lost or taken
 *
 * Reference contracts (templates.ts) are given to the model as the patterns to
 * follow. A failure at any gate is fed back to the model for another attempt.
 */
import { llm } from "../llm.js";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { parseAbiItem } from "viem";
import { compileSolidity, CompileError, type CompiledContract } from "./compiler.js";
import { lintSolidity } from "./lint.js";
import { REFERENCE_CONTRACTS } from "./templates.js";

const AuthoredSchema = z.object({
  contractName: z.string().describe("The name of the contract to deploy, exactly as declared in the source"),
  source: z.string().describe("The complete, self-contained Solidity source file"),
  constructorArgs: z.array(z.string()).describe("Constructor arguments in order, as strings. Empty when the constructor takes none"),
  summary: z.string().describe("Two or three plain sentences for the user: what this contract does and who can use it"),
});

const AuditSchema = z.object({
  safe: z.boolean().describe("False when anyone other than the owner can move or lock the contract's funds, or the contract can lose funds in a way its description does not intend"),
  concerns: z.array(z.string()).describe("Each concrete problem found, quoting the function. Empty when safe"),
});

export interface AuthoredContract {
  contractName: string;
  source: string;
  constructorArgs: string[];
  summary: string;
  compiled: CompiledContract;
}

export class ContractAuthoringError extends Error {}

const MAX_ATTEMPTS = 3;

const AUTHOR_PROMPT = `You write Solidity smart contracts that a user's agent will deploy and then call with real funds.
Return one complete, self-contained source file.

Hard rules:
- pragma solidity ^0.8.24; no imports (declare any interface you need inline); do not use selfdestruct, delegatecall or tx.origin.
- The deployer is the owner: store it as an immutable owner set from msg.sender in the constructor. Every function that moves funds, changes state or can be abused is onlyOwner.
- Use custom errors and emit events for important actions. Guard functions that make external calls against re-entrancy.
- Include a rescue function that sends any native token and any ERC-20 held by the contract back to the owner, and a receive() function when the contract must hold native tokens.
- A contract that trades or arbitrages must revert the whole transaction unless it ends with at least the caller's minimum profit, so a failed run only costs gas. Take the minimum profit as a parameter.
- Implement exactly the external function signatures the description requires, with the same names and parameter types.
- Prefer the smallest contract that does the job. Do not add features that were not asked for.
- Do not invent contract addresses. Use only addresses given in the description; pass others in as parameters.

Reference contracts showing the expected patterns:
${REFERENCE_CONTRACTS.map((r) => `--- ${r.name}: ${r.description}\n${r.source}`).join("\n")}`;

const AUDIT_PROMPT = `You audit a Solidity contract before it is deployed with real funds.
You are given its description and source. Decide whether it is safe to deploy.
It is NOT safe if any of these hold: a function that moves funds or changes important state is callable by someone other than the owner;
funds can become locked with no way for the owner to recover them; an external call's failure is silently ignored where that loses funds;
a trading contract can complete without the minimum profit; there is a re-entrancy path that can drain it; the code does something the description does not say.
Report only concrete problems, naming the function. Do not report style issues.`;

/** Every signature the rest of the plan will call must exist on the contract (same name and parameter types). */
function missingFunctions(compiled: CompiledContract, required: string[]): string[] {
  const missing: string[] = [];
  for (const signature of required) {
    let wanted;
    try {
      wanted = parseAbiItem(signature);
    } catch {
      continue; // validated elsewhere
    }
    if (wanted.type !== "function") continue;
    const wantedTypes = wanted.inputs.map((input) => input.type).join(",");
    const found = compiled.abi.some(
      (item) => item.type === "function" && item.name === wanted.name && item.inputs.map((input) => input.type).join(",") === wantedTypes
    );
    if (!found) missing.push(signature);
  }
  return missing;
}

export async function authorContract(input: {
  intent: string;
  chain: string;
  /** Solidity function signatures later plan steps will call on this contract. */
  requiredFunctions: string[];
}): Promise<AuthoredContract> {
  const model = process.env.CONTRACT_AGENT_MODEL || "gpt-4.1";
  const openai = llm();
  const request = [
    `Chain: ${input.chain}`,
    `What the contract must do: ${input.intent}`,
    input.requiredFunctions.length ? `It must expose exactly these external functions:\n${input.requiredFunctions.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: AUTHOR_PROMPT },
    { role: "user", content: request },
  ];

  let lastProblem = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const completion = await openai.beta.chat.completions.parse({
      model,
      messages,
      response_format: zodResponseFormat(AuthoredSchema, "authored_contract"),
    });
    const authored = completion.choices[0].message.parsed;
    if (!authored) {
      lastProblem = "The model did not return a parseable contract";
      continue;
    }
    const feedBack = (problem: string) => {
      lastProblem = problem;
      messages.push({ role: "assistant", content: JSON.stringify(authored) });
      messages.push({ role: "user", content: `The contract was rejected: ${problem}\nFix it and return the full corrected contract.` });
    };

    const lint = lintSolidity(authored.source);
    if (lint.length) {
      feedBack(lint.map((issue) => issue.message).join(" "));
      continue;
    }
    let compiled: CompiledContract;
    try {
      compiled = compileSolidity(authored.source, authored.contractName);
    } catch (err) {
      if (!(err instanceof CompileError)) throw err;
      feedBack(`It does not compile:\n${err.message}`);
      continue;
    }
    const missing = missingFunctions(compiled, input.requiredFunctions);
    if (missing.length) {
      feedBack(`These required functions are missing or have different parameter types: ${missing.join("; ")}`);
      continue;
    }

    const audit = await openai.beta.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: AUDIT_PROMPT },
        { role: "user", content: `Description: ${input.intent}\n\nSource:\n${authored.source}` },
      ],
      response_format: zodResponseFormat(AuditSchema, "audit"),
    });
    const verdict = audit.choices[0].message.parsed;
    if (verdict && !verdict.safe) {
      feedBack(`The audit found problems: ${verdict.concerns.join("; ")}`);
      continue;
    }

    return { contractName: compiled.name, source: authored.source, constructorArgs: authored.constructorArgs, summary: authored.summary, compiled };
  }
  throw new ContractAuthoringError(`Could not produce a safe, compilable contract after ${MAX_ATTEMPTS} attempts. Last problem: ${lastProblem}`);
}
