import { encodeFunctionData, erc20Abi, formatUnits, maxUint256, parseUnits, createPublicClient } from "viem";
import type { Account } from "viem";
import type { PlanStep, WalletStateSnapshot } from "../models.js";
import { VIEM_CHAIN } from "../tokenRegistry.js";
import { getChain } from "../chains/index.js";
import { alchemyHttp } from "../adapters/alchemyTransport.js";
import { getAaveSupplyApy } from "../adapters/aaveYield.js";
import { getHealthFactor } from "../adapters/aaveHealthFactor.js";
import { OrchestratorError, type BuiltStep } from "../execution/shared.js";
import { PlanValidationError, type Capability } from "./types.js";

/** Aave aToken balances accrue between planning and signing. When a candidate
 * asks for the whole observed position, preserve that intent as `all` so the
 * executor uses Aave's uint256.max full-withdraw semantic instead of a stale
 * decimal snapshot. Explicit partial withdrawals remain fixed amounts. */
function normalizeStep(step: PlanStep, states: WalletStateSnapshot[]): PlanStep {
  if (step.amountIn === "all" || !step.transferFrom) return step;
  const positions = states.flatMap((state) =>
    state.balances
      .filter((balance) => balance.position?.protocol === "aave")
      .map((balance) => ({
        address: state.address.toLowerCase(),
        chain: balance.chain.toLowerCase(),
        asset: balance.position!.underlyingToken.toUpperCase(),
        amount: balance.amount,
      }))
  );
  const position = positions.find(
    (candidate) =>
      candidate.address === step.transferFrom!.toLowerCase() &&
      candidate.chain === step.chainFrom.toLowerCase() &&
      candidate.asset === step.tokenIn.toUpperCase()
  );
  const requested = Number(step.amountIn);
  return position && Number.isFinite(requested) && requested >= position.amount * 0.999999 ? { ...step, amountIn: "all" } : step;
}

async function buildTx(
  step: PlanStep,
  resolvedAmountIn: number,
  fromAddress: `0x${string}`,
  recipientAddress: `0x${string}`
): Promise<BuiltStep> {
    if (step.protocol?.toLowerCase() !== "aave") {
      throw new OrchestratorError(`No withdrawal adapter for protocol "${step.protocol}" yet — only Aave is wired up`, step.id);
    }
    if (step.amountIn === "all") {
      const health = await getHealthFactor(step.chainFrom, fromAddress);
      if (health.totalDebtBase > 0) {
        throw new OrchestratorError(
          `Cannot fully withdraw Aave collateral while ${health.totalDebtBase.toFixed(2)} of debt remains (health factor ${health.healthFactor.toFixed(2)})`,
          step.id
        );
      }
    }
    const aave = await getAaveSupplyApy(step.chainFrom, step.tokenIn);
    const pool = getChain(step.chainFrom)?.aavePool;
    if (!pool) throw new OrchestratorError(`Aave is not available on ${step.chainFrom}`, step.id);
    const decimals = aave.decimals;
    // Aave V3 explicitly treats uint256.max as "withdraw the entire supplied
    // balance". It avoids converting an interest-accruing aToken balance
    // through JavaScript's decimal number representation, where rounding one
    // smallest unit upward can make an otherwise valid full withdrawal revert.
    const amount = step.amountIn === "all" ? maxUint256 : parseUnits(String(resolvedAmountIn), decimals);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "to", type: "address" },
          ],
          outputs: [{ name: "", type: "uint256" }],
        },
      ] as const,
      functionName: "withdraw",
      args: [aave.underlyingAddress, amount, recipientAddress],
    });
    return {
      tx: { to: pool, data, value: "0x0" },
      outputSymbol: step.tokenOut.toUpperCase(),
      outputTokenAddress: aave.underlyingAddress,
      outputDecimals: decimals,
    };
}

export const protocolWithdraw: Capability = {
  id: "protocol_withdraw",
  label: "Withdraw",
  summary: "Withdraw an existing lending position back to the wallet.",
  availableOn: (chain) => Boolean(chain.aavePool),
  promptRules: `- A protocol_withdraw step unwinds an existing protocol position. For Aave it
  must set protocol="aave", tokenIn=tokenOut to the underlying asset, and use
  the same chain for chainFrom/chainTo. A wallet-state line marked "Aave ...
  supply position" is not a normal ERC20: withdraw it before routing that
  underlying asset onward.
- Goal.existingProtocolPositions is authoritative scope. When it is "preserve",
  do not emit protocol_withdraw for any position present in Wallet states. When
  it is "include", existing positions are part of the requested asset movement.
  When it is "unspecified", withdraw an existing position only when the user's
  requested operation specifically consumes that position; its mere presence
  in the wallet never makes a withdrawal necessary.`,
  approvesInput: false,
  normalizeStep,
  validateStep(step, ctx) {
    if (
      step.protocol?.toLowerCase() !== "aave" ||
      step.chainFrom.toLowerCase() !== step.chainTo.toLowerCase() ||
      step.tokenIn.toUpperCase() !== step.tokenOut.toUpperCase()
    ) {
      throw new PlanValidationError(`${step.id}: an Aave withdraw must remain on one chain and use its underlying asset as both tokenIn and tokenOut`);
    }
    const preserved = ctx.preservedPositions.find(
      (position) =>
        position.address.toLowerCase() === (step.transferFrom ?? "").toLowerCase() &&
        position.chain === step.chainFrom.toLowerCase() &&
        position.asset === step.tokenIn.toUpperCase()
    );
    if (preserved) {
      throw new PlanValidationError(
        `${step.id}: the user scoped existing protocol positions out of this goal; the existing Aave ${preserved.asset} position on ${preserved.chain} must be preserved`
      );
    }
  },
  validatePlan(plan, ctx) {
    for (const position of ctx.requiredWithdrawals) {
      const preservedAsBorrowCollateral = plan.steps.some(
        (step) =>
          step.action === "protocol_borrow" &&
          step.protocol?.toLowerCase() === "aave" &&
          step.transferFrom?.toLowerCase() === position.address.toLowerCase() &&
          step.chainFrom.toLowerCase() === position.chain
      );
      if (preservedAsBorrowCollateral) continue;
      const withdrawal = plan.steps.find(
        (step) =>
          step.action === "protocol_withdraw" &&
          step.protocol?.toLowerCase() === "aave" &&
          step.transferFrom?.toLowerCase() === position.address.toLowerCase() &&
          step.chainFrom.toLowerCase() === position.chain &&
          step.tokenIn.toUpperCase() === position.asset
      );
      if (!withdrawal) {
        throw new PlanValidationError(
          `The plan never withdraws the existing Aave ${position.asset} position on ${position.chain} from requested source ${position.address}`
        );
      }
    }
  },
  buildTx,
  async resolveAllAmount(step: PlanStep, account: Account): Promise<number> {
    const reserve = await getAaveSupplyApy(step.chainFrom, step.tokenIn);
    const client = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
    const raw = await client.readContract({
      address: reserve.aTokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    const amount = Number(formatUnits(raw, reserve.decimals));
    if (amount <= 0) throw new OrchestratorError(`No Aave ${step.tokenIn} position is available for amountIn "all"`, step.id);
    return amount;
  },
};
