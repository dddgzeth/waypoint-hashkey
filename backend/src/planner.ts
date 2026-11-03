/**
 * Planner: Goal + WalletState -> ExecutionPlan with a dependency graph.
 *
 * Design principle: the LLM "proposes" a candidate plan, but whether it's
 * actually executable (are the dependency references valid, are the
 * chains/protocols within what we support) is decided by deterministic
 * code, not "whatever the LLM said." This layer corresponds to the
 * "state machine + validation" front-end of the Orchestrator in plan.md's
 * architecture diagram; the real execution-time state machine lives in
 * orchestrator.ts (handles retries/failure recovery during actual
 * execution, not yet implemented).
 */
import { llm } from "./llm.js";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  ExecutionPlanSchema,
  PlanStepSchema,
  type ExecutionPlan,
  type Goal,
  type WalletStateSnapshot,
  type WalletListEntry,
  describeWalletStates,
  describeWalletList,
} from "./models.js";
import { findBestAaveYield } from "./adapters/aaveYield.js";
import { getUsdPrice } from "./adapters/priceUsd.js";
import { getMemory } from "./memory/index.js";
import { CHAIN_KEYS, chainsWithAave } from "./chains/index.js";
import { resolveLiveProtocolTokenReferences } from "./protocolTokenResolver.js";
import {
  PlanValidationError,
  actionListText,
  actionRulesText,
  capabilityIds,
  allCapabilities,
  getCapability,
  type PositionRef,
} from "./capabilities/index.js";

export { PlanValidationError };

const SUPPORTED_CHAINS = new Set(CHAIN_KEYS);
// "morpho" used to be in this list alongside "aave", but orchestrator.ts only
// ever had a real Aave adapter — a plan step could pass validation here and
// then hard-fail at execution with "only Aave is wired up". Whitelisting a
// protocol we don't actually execute was worse than not listing it; removed
// rather than left as a trap. Add it back only alongside a real adapter.
const SUPPORTED_PROTOCOLS = new Set(["aave"]);

const PLANNER_SYSTEM_PROMPT = `You are Waypoint's planner module.
Input: the user's goal + their current real cross-chain asset state.
Output: a linear dependency step graph (steps) that achieves the goal.

Rules:
- Each step's action must be one of: ${actionListText()}
- Only these chains may be used: ${CHAIN_KEYS.join(", ")}
- Token identifiers may be a displayed symbol or an ERC-20 contract address. When the goal
  or wallet state names a 0x token address, copy that exact address into tokenIn/tokenOut;
  it is executable for swap, bridge and transfer. Aave supply/withdraw remains limited to
  the verified Aave reserve assets returned by the live yield lookup.
- transferFrom names which wallet funds/signs a step — this applies to EVERY action type,
  not just transfer. Leave it null when the user did NOT name a specific source wallet for
  that step (e.g. "consolidate my assets and deposit into Aave" said about a single
  wallet — the source is implicitly whichever wallet ends up executing the plan, unchanged
  from before). Set it to a real resolved address when the user named which wallet a
  step's funds should come FROM — that step can then only be signed by whoever actually
  controls that exact wallet.
- Goal.sourceWalletLabels is the authoritative list of user-named sources. Every listed
  source must appear as transferFrom on one or more steps. Wallet labels in the state
  section identify both the balances and the real addresses to use; never omit a named
  source merely because another wallet is currently selected in chat.
- transferTo, for any NON-transfer action type, is an OPTIONAL override for where that
  step's output should land, when it should go to a wallet OTHER than the one that signed
  it (leave it null otherwise — the default is the signer's own address, unchanged from
  before). This is how a goal spanning MULTIPLE named wallets gets expressed as one plan:
  e.g. "consolidate execution wallet 1, execution wallet 2, and execution wallet 3, then
  deposit into the best-yielding Aave market" — pick one of the named wallets as the real
  target (the one that ends up holding everything and making the deposit), then for every
  OTHER named wallet, generate a step moving its assets there: same-chain -> a transfer
  step (transferFrom = that wallet, transferTo = the target wallet); cross-chain -> a
  bridge/swap step (transferFrom = that wallet, transferTo = the target wallet, so the
  bridged output lands in the target instead of bouncing back to the source). A separate
  output path needs its own protocol_supply step using output_of(that path); do not invent
  an aggregate amount from several asynchronous bridge outputs. Each supply step must use
  transferFrom = the target wallet. Never leave transferFrom null on a consolidating step
  just because the OVERALL goal has one "primary" wallet; each step's own named source
  still needs to be set so it gets signed by the right key.
- The user may refer to a recipient, a source, or a destination by a wallet's label (e.g.
  a nickname they set) instead of a literal address — resolve it against the known wallet
  list given below and put the real address in transferTo / transferFrom. Never invent an
  address; if a referenced wallet isn't in that list, this is unresolvable — say so instead
  of guessing.
- When a step involves a third-party protocol deposit, set the protocol field to the
  protocol name. Aave supply/withdraw uses the direct Pool adapter.
- If a step's input amount comes from a previous step's output, write amountIn as
  "output_of(<previous step id>)" — never invent a concrete number
- Use amountIn "all" only for an ERC20 balance held by the step's signer. It
  resolves at execution time to that wallet's actual current balance, so it is
  appropriate for the final USDC supply after several bridge deliveries. Never
  use "all" for native assets because those must retain gas.
- Otherwise amountIn must be a bare number as a string, e.g. "0.00015" — never
  include the token symbol or any other text (not "0.00015 ETH")
- Number each step's id incrementally as step1, step2, step3, ...
- dependsOn must accurately list the ids of the steps this one depends on
${actionRulesText()}`;


const OUTPUT_OF_RE = /^output_of\(([^)]+)\)$/;

/** Resolve account-local wallet labels at the boundary between natural-language planning and executable steps. */
function resolveWalletReferences(plan: ExecutionPlan, wallets: WalletListEntry[]): ExecutionPlan {
  const byLabel = new Map(wallets.map((wallet) => [wallet.label.trim().toLowerCase(), wallet.address]));
  const optional = (value: string | null): string | null => {
    const normalized = value?.trim() ?? "";
    // Structured-output models sometimes serialize an absent nullable field
    // as "/null", ":null," or just punctuation. These are not recipient
    // labels, addresses, or protocol names; normalize the transport noise
    // before semantic validation.
    const marker = normalized.replace(/[\s/:.,'"`]+/g, "").toLowerCase();
    return marker && marker !== "null" ? normalized : null;
  };
  const resolve = (value: string | null): string | null => {
    const normalized = optional(value);
    if (!normalized) return null;
    const exact = byLabel.get(normalized.toLowerCase());
    if (exact) return exact;

    // People naturally qualify a wallet name with its chain, e.g.
    // "执行钱包3（Polygon）". The chain is useful prose but is not part of
    // the account-local label. Accept only a label followed by a parenthetic
    // qualifier; do not fuzzy-match arbitrary recipient text to a wallet.
    const qualified = normalized.match(/^(.+?)\s*[（(][^）)]+[）)]\s*$/);
    if (qualified) {
      const address = byLabel.get(qualified[1].trim().toLowerCase());
      if (address) return address;
    }
    return normalized;
  };
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      transferFrom: resolve(step.transferFrom),
      transferTo: resolve(step.transferTo),
      protocol: optional(step.protocol),
      vendorAdapter: optional(step.vendorAdapter),
    })),
  };
}

/**
 * Plans store ERC-20s by contract address. The model is allowed to use the
 * display symbol it just saw in a live wallet snapshot, but that shorthand is
 * normalized here only when that snapshot identifies one unambiguous contract
 * on the relevant chain. There is no global token-symbol/address table.
 */
function resolvePlanTokenReferences(plan: ExecutionPlan, states: WalletStateSnapshot[]): ExecutionPlan {
  const byChainAndSymbol = new Map<string, string>();
  for (const state of states) {
    for (const balance of state.balances) {
      const key = `${balance.chain.toLowerCase()}:${balance.token.toLowerCase()}`;
      const identifier = balance.tokenAddress ?? balance.token;
      const prior = byChainAndSymbol.get(key);
      // A collision is deliberately not resolved by a ticker guess.
      if (prior === undefined) byChainAndSymbol.set(key, identifier);
      else if (prior.toLowerCase() !== identifier.toLowerCase()) byChainAndSymbol.set(key, "");
    }
  }
  const resolve = (chain: string, token: string) => {
    if (/^0x[a-fA-F0-9]{40}$/.test(token)) return token;
    const found = byChainAndSymbol.get(`${chain.toLowerCase()}:${token.toLowerCase()}`);
    return found || token;
  };
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      tokenIn: resolve(step.chainFrom, step.tokenIn),
      tokenOut: resolve(step.chainTo, step.tokenOut),
    })),
  };
}

/** Lets each capability rewrite the steps it owns after the model proposes them. */
function normalizeSteps(plan: ExecutionPlan, states: WalletStateSnapshot[]): ExecutionPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => getCapability(step.action)?.normalizeStep?.(step, states) ?? step),
  };
}

export function validatePlan(
  plan: ExecutionPlan,
  requiredSources: WalletListEntry[],
  requiredDeposit?: { chain: string; asset: string },
  requiredWithdrawals: PositionRef[] = [],
  preservedPositions: PositionRef[] = []
): void {
  if (plan.steps.length === 0) {
    throw new PlanValidationError("The plan contains no executable steps");
  }
  const seenIds = new Set<string>();
  const stepsById = new Map<string, (typeof plan.steps)[number]>();
  const knownWalletAddresses = new Set(requiredSources.map((wallet) => wallet.address.toLowerCase()));
  const knownWalletLabels = requiredSources.map((wallet) => `"${wallet.label}"`).join(", ");
  for (const step of plan.steps) {
    const capability = getCapability(step.action);
    if (!capability) {
      throw new PlanValidationError(`${step.id}: unsupported action ${step.action}`);
    }
    if (!SUPPORTED_CHAINS.has(step.chainFrom.toLowerCase())) {
      throw new PlanValidationError(`${step.id}: unsupported chain ${step.chainFrom}`);
    }
    if (!SUPPORTED_CHAINS.has(step.chainTo.toLowerCase())) {
      throw new PlanValidationError(`${step.id}: unsupported chain ${step.chainTo}`);
    }
    if (step.protocol && !SUPPORTED_PROTOCOLS.has(step.protocol.toLowerCase())) {
      throw new PlanValidationError(`${step.id}: unsupported protocol ${step.protocol}`);
    }
    // transferFrom/transferTo now apply to any action type (see models.ts's
    // doc comments) — format-checked universally here, not just for transfer.
    if (step.transferFrom && !/^0x[a-fA-F0-9]{40}$/.test(step.transferFrom)) {
      throw new PlanValidationError(`${step.id}: transferFrom must be a real resolved address, not a label or placeholder`);
    }
    if (step.transferFrom && !knownWalletAddresses.has(step.transferFrom.toLowerCase())) {
      throw new PlanValidationError(`${step.id}: transferFrom is not one of the requested source wallets`);
    }
    if (!capability.transferToRequired && step.transferTo && !/^0x[a-fA-F0-9]{40}$/.test(step.transferTo)) {
      throw new PlanValidationError(
        `${step.id}: transferTo "${step.transferTo}" is not a resolved address. Use one of ${knownWalletLabels} or a 0x address.`
      );
    }
    for (const dep of step.dependsOn) {
      if (!seenIds.has(dep)) {
        throw new PlanValidationError(
          `${step.id}: depends on a step that hasn't appeared yet (${dep}) — dependencies must point to earlier steps, cycles are not allowed`
        );
      }
    }

    // When an amount references a previous step's output, the chain and token must
    // line up with that step's actual output — testing showed the model sometimes
    // stitches two unrelated funding paths together (e.g. claiming assets "come from
    // base" while the referenced step's output actually landed on arbitrum). Caught
    // deterministically here.
    const match = OUTPUT_OF_RE.exec(step.amountIn);
    if (!match && step.amountIn !== "all" && Number.isNaN(Number(step.amountIn))) {
      // Testing showed the model sometimes appends the token symbol to amountIn
      // (e.g. "0.00015 ETH" instead of "0.00015") — Number() can't parse that, and
      // neither can the orchestrator's own amountIn resolver, so this must be
      // caught here rather than surfacing as an execution-time crash.
      throw new PlanValidationError(
        `${step.id}: amountIn "${step.amountIn}" is neither a bare number nor an output_of() reference`
      );
    }
    let refStep: (typeof plan.steps)[number] | undefined;
    if (match) {
      const refId = match[1];
      refStep = stepsById.get(refId);
      if (!refStep) {
        throw new PlanValidationError(`${step.id}: amountIn references a step that doesn't exist (${refId})`);
      }
      if (!step.dependsOn.includes(refId)) {
        throw new PlanValidationError(
          `${step.id}: amountIn references ${refId}'s output, but dependsOn doesn't declare that dependency`
        );
      }
      if (refStep.chainTo.toLowerCase() !== step.chainFrom.toLowerCase()) {
        throw new PlanValidationError(
          `${step.id}: references ${refId}'s output, but ${refId}'s output lands on ${refStep.chainTo}, ` +
            `while this step claims the asset comes from ${step.chainFrom} (chain discontinuity)`
        );
      }
      if (refStep.tokenOut.toLowerCase() !== step.tokenIn.toLowerCase()) {
        throw new PlanValidationError(
          `${step.id}: references ${refId}'s output (${refStep.tokenOut}), ` +
            `but this step's tokenIn is ${step.tokenIn} (token discontinuity)`
        );
      }
    }

    capability.validateStep?.(step, { knownWalletLabels, preservedPositions, refStep, stepsById });

    seenIds.add(step.id);
    stepsById.set(step.id, step);
  }

  for (const source of requiredSources) {
    if (!plan.steps.some((step) => step.transferFrom?.toLowerCase() === source.address.toLowerCase())) {
      throw new PlanValidationError(`The plan never spends from the requested source wallet \"${source.label}\"`);
    }
  }

  // Plan-level rules a capability owns apply even when the plan holds no step of that kind (a required
  // withdrawal or deposit the plan forgot), so every registered capability is asked.
  const planContext = { requiredDeposit, requiredWithdrawals };
  for (const capability of allCapabilities()) capability.validatePlan?.(plan, planContext);
}

const MAX_PLAN_ATTEMPTS = 3;

/** Lets each capability finish the steps it owns (for example writing the contract a deploy step describes). */
async function prepareSteps(plan: ExecutionPlan): Promise<ExecutionPlan> {
  const steps: ExecutionPlan["steps"] = [];
  for (const step of plan.steps) {
    const prepare = getCapability(step.action)?.prepareStep;
    steps.push(prepare ? await prepare(step, plan) : step);
  }
  return { ...plan, steps };
}

/** The structured-output schema the model must satisfy, with `action` restricted to the registered capabilities. */
function planResponseSchema() {
  const step = PlanStepSchema.extend({ action: z.enum(capabilityIds()) });
  return ExecutionPlanSchema.extend({ steps: z.array(step) });
}

export async function buildPlan(
  goal: Goal,
  states: WalletStateSnapshot[],
  wallets: WalletListEntry[] = [],
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  memoryContext?: string
): Promise<ExecutionPlan> {
  const stateAddresses = new Set(states.map((state) => state.address.toLowerCase()));
  const executableWallets = wallets.filter((wallet) => stateAddresses.has(wallet.address.toLowerCase()));
  const requestedSources = goal.sourceWalletLabels.map((label) => {
    const wallet = executableWallets.find((candidate) => candidate.label.toLowerCase() === label.toLowerCase());
    if (!wallet) throw new PlanValidationError(`Requested source wallet \"${label}\" is not available on this account`);
    return wallet;
  });
  // server.ts orders states with the chat-selected wallet first. An omitted
  // source means "this wallet" in normal conversation, not every linked or
  // execution wallet in the account. Multi-wallet scope remains explicit via
  // Goal.sourceWalletLabels.
  const selectedWallet = executableWallets.find((wallet) => wallet.address.toLowerCase() === states[0]?.address.toLowerCase());
  const requiredSources = requestedSources.length ? requestedSources : selectedWallet ? [selectedWallet] : executableWallets;
  const requiredSourceAddresses = new Set(requiredSources.map((wallet) => wallet.address.toLowerCase()));
  const existingPositions = states.flatMap((state) =>
    requiredSourceAddresses.has(state.address.toLowerCase())
      ? state.balances
          .filter((balance) => balance.position?.protocol === "aave")
          .map((balance) => ({
            address: state.address,
            chain: balance.chain.toLowerCase(),
            asset: balance.position!.underlyingToken.toUpperCase(),
          }))
      : []
  );
  const requiredWithdrawals = goal.existingProtocolPositions === "include" ? existingPositions : [];
  const preservedPositions = goal.existingProtocolPositions === "preserve" ? existingPositions : [];
  let yieldNote = "";
  let requiredDeposit: { chain: string; asset: string } | undefined;
  if (goal.needsYieldLookup) {
    // Real bug caught by real testing: the goal parser once put a description
    // ("whichever chain has the best yield") into targetChain instead of null.
    // That string isn't a real chain key, so findBestAaveYield's own chain
    // filter would silently reject it, throw "none of the candidate chains
    // are supported," and fall into the catch below — turning a "compare
    // real yields" request into the model guessing from memory instead
    // (and it guessed wrong: it picked Polygon at 2.7% APY when Ethereum was
    // live at 3.8%). Only trust targetChain here if it's a real, known chain.
    const namedChain = goal.targetChain?.toLowerCase();
    const candidateChains = namedChain && SUPPORTED_CHAINS.has(namedChain) ? [namedChain] : chainsWithAave().map((c) => c.key);
    const asset = goal.targetAsset ?? "USDC";
    try {
      const best = await findBestAaveYield(candidateChains, asset);
      requiredDeposit = { chain: best.chain, asset: best.asset };
      yieldNote = `\n\nLive yield destination (authoritative): Aave ${best.asset} on ${best.chain}, APY ${best.apy.toFixed(2)}%. Every protocol_supply step MUST deposit ${best.asset} on ${best.chain}; do not choose a same-chain convenience market instead.`;
    } catch (err) {
      // A lookup failure (e.g. the target asset has no Aave reserve on any candidate
      // chain) shouldn't fail the whole planning run — feed the reason back to the
      // model and let it decide how to fall back, rather than hard-coding a default
      // in our own code.
      const message = err instanceof Error ? err.message : String(err);
      yieldNote = `\n\nLive yield lookup failed (${message}). Pick an Aave deposit on one of the candidate chains based on what you already know, and make clear in the plan that this choice wasn't verified against live data.`;
    }
  }

  let priceNote = "";
  if (goal.targetAsset) {
    // A dollar-denominated amount ("~$4 of ETH") otherwise gets converted by
    // the model estimating a price from training data — real bug caught by
    // real testing: it guessed a stale/wrong ETH price and turned "$4" into
    // an amount worth barely half that. Always hand it a real live price as a
    // fact (same "compute deterministically, hand the model a fact" pattern
    // as the yield lookup above) and let it read goal.action itself to judge
    // whether the user's amount was dollar- or token-denominated — an
    // upstream field trying to pre-classify that turned out more brittle
    // than just trusting the model's own reading of the actual sentence.
    try {
      const price = await getUsdPrice(goal.targetAsset);
      priceNote = `\n\nLive price lookup: 1 ${goal.targetAsset} = $${price.toFixed(2)}. If the user's amount was dollar-denominated, convert it with this real price — don't estimate your own. If it was already token-denominated, use it as given.`;
    } catch {
      // No live price available for this asset — not fatal, just means a
      // dollar-denominated amount (if any) has to be estimated instead of
      // converted exactly; the model already knows to flag that in the plan.
    }
  }

  // Execution knowledge base (plan-finals-v2.md §1): a small factual corpus
  // mined from real bugs this project has hit, retrieved by keyword rather
  // than bundled into every prompt (same "Query Recipe" pattern Cobo Agentic
  // Wallet's own pipeline uses) — never a code-level rule, just a fact handed
  // to the model to read and apply on its own judgment. Keywords come from
  // the already-structured Goal fields (chain/asset/action), not the raw
  // sentence, mirroring `caw recipe search --keywords`.
  const knowledgeQuery = [goal.targetChain, goal.targetAsset, goal.action].filter(Boolean).join(" ");
  const knowledgeNote = getMemory().knowledge(knowledgeQuery);

  const openai = llm();
  const systemPrompt = memoryContext ? `${PLANNER_SYSTEM_PROMPT}\n\n${memoryContext}` : PLANNER_SYSTEM_PROMPT;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Goal: ${JSON.stringify(goal)}\n\nWallet states:\n${describeWalletStates(states)}\n\n${describeWalletList(wallets)}${yieldNote}${priceNote}${knowledgeNote ? `\n\n${knowledgeNote}` : ""}`,
    },
  ];

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const completion = await openai.beta.chat.completions.parse({
      model,
      messages,
      response_format: zodResponseFormat(planResponseSchema(), "execution_plan"),
    });

    const candidate = completion.choices[0].message.parsed;
    if (!candidate) {
      lastError = new Error("Planning failed: the model did not return a parseable structured output");
      continue;
    }

    const tokenResolved = resolvePlanTokenReferences(resolveWalletReferences(candidate, wallets), states);
    const parsed = normalizeSteps(await resolveLiveProtocolTokenReferences(tokenResolved), states);

    try {
      validatePlan(parsed, requiredSources, requiredDeposit, requiredWithdrawals, preservedPositions);
      if (attempt > 1) {
        console.log(`(passed validation after attempt ${attempt})`);
      }
      return await prepareSteps(parsed);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Feed the specific validation failure reason back to the model so it can
      // self-correct on the next attempt — a simplified version of the "failure
      // handling" plan.md's Orchestrator design calls for.
      messages.push({ role: "assistant", content: JSON.stringify(parsed) });
      messages.push({
        role: "user",
        content: `The plan above failed validation, reason: ${lastError.message}. Please fix it and return the full corrected plan.`,
      });
    }
  }

  throw new PlanValidationError(
    `Failed to produce a valid plan after ${MAX_PLAN_ATTEMPTS} attempts. Last error: ${lastError?.message}`
  );
}
