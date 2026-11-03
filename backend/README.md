# Waypoint Backend (TypeScript)

Corresponds to layers 2-5 of `plan.md`'s architecture diagram: state aggregation
layer -> goal parser (LLM) -> planner (LLM + deterministic validation) -> orchestrator
(real on-chain execution).

## Environment

Requires Node.js >= 22 (`nvm use 22`; the repo's `hyperframes` tooling also requires
this version, so it's kept consistent).

## Running it

```bash
nvm use 22
npm install
export OPENAI_API_KEY=sk-...

# Option 1: run all three layers end to end from the CLI and print the result
npm run demo
npm run demo -- "Swap USDC on Polygon to ETH, bridge it to Arbitrum, and deposit into Aave"

# Option 2: start the Express server
npm run dev
# then POST http://127.0.0.1:8787/plan  body: {"goalText": "...", "walletAddress": "0x..."}
```

Set `EXECUTOR_PRIVATE_KEY` in `.env` to read real on-chain balances for that wallet's
address (`npm run demo` only); otherwise `npm run demo` falls back to the mock wallet
state from `plan.md` Section 4.1. `server.ts`'s `/plan` endpoint reads real state
whenever `walletAddress` is provided in the request body, mock state otherwise.
`EXECUTOR_PRIVATE_KEY` is also the signer `orchestrator.ts` uses to actually send
transactions — treat it as a hot wallet key, keep it out of version control, and only
fund it with amounts you're comfortable losing.

## Directory structure

```
backend/
  src/
    models.ts             WalletState / Goal / PlanStep / ExecutionPlan (zod schema + type)
    stateReader.ts         State aggregation layer — real viem multicall reads across
                            base/arbitrum/polygon/robinhood (native token + stablecoin)
    goalParser.ts           Goal parser, OpenAI structured output (zodResponseFormat) -> Goal
    planner.ts               Planner, OpenAI structured output -> ExecutionPlan + deterministic validation
    server.ts                 Express /plan endpoint
    runDemo.ts                 CLI one-shot run of all three layers
    orchestrator.ts             Execution-time state machine — simulates, then signs
                                  and broadcasts each plan step for real, sequentially,
                                  behind a hard per-step USD safety cap
    adapters/
      aaveYield.ts               Real-time Aave V3 supply APY via the core Pool contract
                                  (getReserveData), Arbitrum + Base
      enso.ts                    Real Enso Shortcuts routing for same-chain Aave deposits
      lifi.ts                    Real LI.FI quotes + cross-chain /status polling (swap/bridge)
      relay.ts                   Real Relay.link quotes + /intents/status/v3 polling
                                  (alternative bridge, selected via a plan step's
                                  vendorAdapter field)
      priceUsd.ts                 CoinGecko USD pricing, used only for the safety cap check
```

## Verified

- `npx tsc --noEmit` passes clean
- **Goal parser + planner run fully end to end against the real OpenAI API**
  (`gpt-4o-mini` / `gpt-5.6-terra`). Repeated runs surfaced and fixed 4 real planning
  defects:
  1. The model would generate a no-op "same chain, same token" swap step ->
     caught by `validatePlan`
  2. `protocol_supply` steps sometimes left `tokenOut` blank -> now required to match
     `tokenIn`
  3. The model would stitch together two unrelated funding paths (the referenced
     step's output chain/token didn't match this step's `chainFrom`/`tokenIn`) ->
     added chain/token continuity validation
  4. The model would label a cross-chain action as plain `swap` instead of
     `cross_chain_swap`/`bridge` -> added an action-type vs. same-chain/cross-chain
     consistency check
  - Added a failure-retry loop (`MAX_PLAN_ATTEMPTS=3`) that feeds the validation
    error back to the model so it can self-correct; throws a clear error after 3
    failed attempts rather than silently returning a broken plan
- **State reader (`stateReader.ts`) runs real `viem` multicall reads** across four
  chains (base/arbitrum/polygon/robinhood) — native balance + the chain's dollar
  stablecoin (Robinhood Chain's is USDG, not USDC). No API key required.
- **Aave APY lookup (`adapters/aaveYield.ts`) reads live on-chain data** via the
  Aave V3 core `Pool.getReserveData(asset)` view function on Arbitrum and Base — not
  a mock, not the periphery `UiPoolDataProvider` helper (its documented struct
  layout didn't match what's actually deployed; the ABI here was pulled from the
  verified implementation contract behind the proxy, confirmed identical on both
  chains). `findBestAaveYield` compares APY across candidate chains and feeds the
  result straight into the planner's system prompt.
- **`orchestrator.ts` has executed real plans against mainnet, with real funds**,
  capped at `MAX_STEP_USD` (currently $2) per step and always simulated
  (`eth_call`) before anything is signed:
  - Same-chain swap (LI.FI) and same-chain Aave deposit (Enso), chained via
    `output_of(step1)` — the deposit step's input was resolved from the swap
    step's actual measured output, not the LLM's estimate.
  - Cross-chain bridge via LI.FI (0.0003 ETH, Arbitrum -> Base USDC), delivery
    confirmed via LI.FI's own `/status` endpoint polled by source tx hash.
  - Cross-chain bridge via Relay.link (same route), delivery confirmed via
    Relay's `/intents/status/v3` endpoint polled by requestId, then the actual
    received amount read from the destination transaction's own ERC20 Transfer
    log (Relay's status payload doesn't document a reliable amount field, so
    this avoids depending on one).
  - **The full two-chain dependency scenario, chained in one `runPlan` call**:
    0.0002 ETH bridged Arbitrum -> Base via LI.FI (received 0.353713 USDC,
    confirmed via `/status`), then that exact measured amount deposited into
    Aave on Base via Enso (received 0.353713 aUSDC) — `output_of(step1)`
    resolved from the real cross-chain delivery, not an estimate. This is the
    specific "bridge, then deposit into a specific protocol" dependency chain
    the project's pitch is built around (the one a single-action agent like
    Bankr can't do in one request).
- **The full closed loop has run end to end, once, for real**: natural-language
  goal text -> real `parseGoal` (LLM) -> real `buildPlan` (LLM + live Aave APY
  lookup) -> the resulting plan handed directly to `runPlan()`, no hand-written
  plan object involved. Result: a real 0.00015 ETH Arbitrum -> Base bridge
  (received 0.279897 USDC) followed by a real Aave deposit of that exact
  amount (received 0.279897 aUSDC). The first attempt caught a real bug this
  way: the model wrote `amountIn: "0.00015 ETH"` (a unit suffix `resolveAmountIn`
  couldn't parse) — `validatePlan()` didn't check that a non-`output_of()`
  amountIn is actually numeric, so it passed validation and only broke in the
  orchestrator. Fixed by adding that check to `validatePlan()` (same
  propose/validate/retry mechanism as the other LLM-output quirks below); no
  funds moved on the failed attempt since it broke before any transaction was
  built.
  - A missing ERC20 approval was caught by `simulate()` before any transaction
    was sent, exactly as designed; `ensureAllowance()` now sends the approval
    automatically when needed.
  - An early bug measured output via before/after balance polling on two
    separate RPC calls and reported a false "0 received" on a real, successful
    swap (public-node lag on the "after" read). Fixed by parsing the actual
    Transfer log(s) in the transaction's own receipt instead — see the
    file-level comment in `orchestrator.ts` for the full writeup.

## Known limitations

- `amountIn` currently only validates a single `output_of(stepX)` reference. The
  model occasionally generates a combined expression like
  `"output_of(step1) + output_of(step2)"`, which **is not covered by the chain/token
  continuity check** (the regex doesn't match it, so it's silently skipped). In
  practice the model usually avoids this and splits it into two separate
  `protocol_supply` steps instead, but that's not guaranteed — either combined
  expressions need to be disallowed, or dedicated parsing/validation needs to be
  written for them.
- The default `gpt-4o-mini` has a non-trivial first-attempt failure rate across
  repeated runs (roughly half needed the retry mechanism to succeed; one run failed
  all 3 retries). Switching to `gpt-5.6-terra` (`OPENAI_MODEL` in `.env`) produced
  noticeably better success rate and completeness across 3 consecutive tests: all 3
  generated a correct 5-step plan (correctly recognizing that the 0.1 ETH already on
  Arbitrum also needed to be included — `gpt-4o-mini` often missed this), 2 of the 3
  passed validation on the first attempt. `gpt-5.6-terra` is recommended for the
  actual demo.
- `findBestAaveYield` currently only compares Aave; Morpho is listed in
  `SUPPORTED_PROTOCOLS` but has no adapter yet, so the model can still name it but
  nothing will validate a live rate for it — `orchestrator.ts`'s `protocol_supply`
  step will throw a clear error rather than attempt it.
- `orchestrator.ts` doesn't retry a failed step; a run stops immediately on the
  first simulation or on-chain failure (see safety rule 3 in its file-level
  comment) rather than retrying with backoff.
- Same-chain steps whose output is a native token (not an ERC20) aren't
  measurable yet — there's no Transfer log to read, and this orchestrator
  deliberately avoids balance-diff polling (see the "Verified" section above for
  why). Refused outright rather than silently guessing.
- Relay routes that require more than one on-chain transaction (e.g. a separate
  approve step for ERC20 input) aren't supported yet — `adapters/relay.ts` throws
  rather than only running the first of several steps.

## Not yet implemented (next steps)

- A Morpho yield adapter, to make `SUPPORTED_PROTOCOLS`'s "morpho" entry real rather
  than just an allowed label.
- Retry/backoff for failed orchestrator steps, and multi-transaction Relay routes.
- A way for the planner to choose between LI.FI and Relay for a given bridge step
  (currently the planner always emits `vendorAdapter: "lifi"`; picking Relay
  requires setting it manually, e.g. for a quote comparison).
- Deliberately out of scope for now: an `/execute` HTTP endpoint. `server.ts`'s
  `/plan` only plans; real execution is CLI-only (see `runDemo.ts` / the pattern in
  the ad-hoc test scripts). The demo doesn't need execution triggered over HTTP, so
  wiring `orchestrator.ts` into the server was intentionally skipped rather than
  left half-done.
