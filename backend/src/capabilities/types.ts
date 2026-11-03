/**
 * A capability is one kind of plan step ("swap", "bridge", "protocol_supply", ...).
 * Everything the platform needs to know about an action lives in one module that
 * implements this interface and is listed once in ./index.ts:
 *
 *   - what it is and where it is available (planner prompt, capability map)
 *   - how a step of this kind is validated (planner)
 *   - how it is executed (server-signed path and browser-signed path)
 *
 * The planner, orchestrator and client executor only dispatch through the
 * registry; they hold no per-action branches. Adding an action means adding a
 * module here and one line in index.ts.
 */
import type { Account, PublicClient } from "viem";
import type { ExecutionPlan, PlanStep, WalletStateSnapshot } from "../models.js";
import type { ChainConfig } from "../chains/types.js";
import type { BuiltStep, ClientStepBuild, ProgressCallback, StepResult } from "../execution/shared.js";

/** Thrown when a model-proposed plan is not executable; the planner feeds the message back to the model. */
export class PlanValidationError extends Error {}

export interface PositionRef {
  address: string;
  chain: string;
  asset: string;
}

export interface StepValidationContext {
  /** Quoted, comma-separated labels of the wallets this plan may use (for error messages). */
  knownWalletLabels: string;
  /** Existing protocol positions the user asked to leave untouched. */
  preservedPositions: PositionRef[];
  /** The step this one reads through output_of(), when it does. */
  refStep?: PlanStep;
  /** The steps that precede this one, by id. */
  stepsById: ReadonlyMap<string, PlanStep>;
}

export interface PlanValidationContext {
  /** The live best-yield destination every supply step must use, when a yield lookup ran. */
  requiredDeposit?: { chain: string; asset: string };
  /** Existing positions the plan must withdraw (the goal said to include them). */
  requiredWithdrawals: PositionRef[];
}

export interface Capability {
  id: string;
  label: string;
  /** One line, shown on the capability map and used as documentation of the action. */
  summary: string;
  /** Whether this action can be used on the given chain (drives the capability map). */
  availableOn(chain: ChainConfig): boolean;
  /** Rules for the planner's system prompt, verbatim text for the model. */
  promptRules: string;
  /** Marks actions whose transferTo is mandatory and validated by the capability itself. */
  transferToRequired?: boolean;

  /** One line describing a step of this kind (plan pretty-printing). Default format is used when absent. */
  describe?(step: PlanStep): string;
  /** Rewrites a step after the model proposes it (for example normalising a full withdrawal). */
  normalizeStep?(step: PlanStep, states: WalletStateSnapshot[]): PlanStep;
  /** Throws PlanValidationError when a step of this kind is not executable. */
  validateStep?(step: PlanStep, ctx: StepValidationContext): void;
  /** Whole-plan checks owned by this action. */
  validatePlan?(plan: ExecutionPlan, ctx: PlanValidationContext): void;
  /**
   * Fills in what the planner cannot: runs after the plan validated, before the user sees it. May call
   * models or the network. Throws PlanValidationError when the step cannot be completed.
   */
  prepareStep?(step: PlanStep, plan: ExecutionPlan): Promise<PlanStep>;

  /** Whether the server-signed path approves the input token for the router before sending. Default true. */
  approvesInput?: boolean;
  /** Same question for the browser-signed path. Default true. */
  clientApprovesInput?: boolean;
  /** Whether the quote is re-fetched right before signing (routed swaps and bridges expire). Default false. */
  refreshQuoteBeforeSend?: boolean;

  /** Builds the transaction for a step. Required unless run() takes over the whole step. */
  buildTx?(step: PlanStep, resolvedAmountIn: number, fromAddress: `0x${string}`, recipientAddress: `0x${string}`): Promise<BuiltStep>;
  /** Replaces the standard simulate / send / confirm / measure flow for the server-signed path. */
  run?(step: PlanStep, resolvedAmountIn: number, account: Account, onProgress?: ProgressCallback): Promise<StepResult>;
  /** Resolves amountIn "all" for actions whose balance is not a plain wallet token balance. */
  resolveAllAmount?(step: PlanStep, account: Account): Promise<number>;
  /** Extra wait for an output only visible through a protocol read. Returns true when it handled the wait. */
  awaitOutputVisible?(step: PlanStep, result: StepResult, recipient: `0x${string}`, clients: PublicClient[]): Promise<boolean>;

  /** Browser-signed path: replaces the standard build step. */
  buildClient?(step: PlanStep, resolvedAmountIn: number, fromAddress: `0x${string}`): Promise<ClientStepBuild>;
  /** Browser-signed path: replaces the standard confirm and measure step. */
  confirmClient?(step: PlanStep, built: ClientStepBuild, txHash: `0x${string}`, receipt: { gasUsed: bigint }): StepResult;
}
