# Waypoint — Finals Plan (NTU InnovateX 2026)

> Shortlisted for on-site finals: **21–23 Aug 2026**. Demo/judging is **Sun 23 Aug, 2:30–4:30 PM** —
> everything below has to be stable well before then, not finished at the wire.
> This is a second-phase plan on top of `plan.md` (Stage 1). `plan.md` stays as-is,
> the historical record of what was pitched and verified for the submission deadline.

## Time budget

- **Fri 21 Aug, PM/evening** — Open Development
- **Sat 22 Aug, full day** — Open Development
- **Sun 23 Aug, AM** — Final Development (demo starts 2:30 PM — stop building with
  enough runway to rehearse, not mid-build)

## Priority order

Do 1, 2, 3 — in that rough order, but 3 gets the most polish since it's the strongest
differentiation story. 4 and 5 are reliability/nice-to-have, done last, cut first if
time runs out.

1. Real frontend, wired to the real backend
2. Memory layer (adapted from TencentDB Agent Memory / Synapse)
3. Conditional/triggered execution — the "autonomous agent" scenario
4. Reliability hardening (retry, validation gaps, Morpho adapter)
5. Automatic bridge-vendor selection (LI.FI vs Relay)

---

## 1. Real frontend, wired to the real backend

### Current state

`frontend/index.html` (deployed at `waypoint.cjlin.com`) is a static mockup: it
replays one real, pre-recorded session with `setTimeout`-choreographed animations.
No `fetch()` calls, no live backend. `server.ts`'s `/plan` endpoint is real
(calls `getWalletState` → `parseGoal` → `buildPlan`) but nothing calls it from a
browser, and there's no `/execute` endpoint at all — deliberately skipped for Stage 1
per the earlier scope decision.

For a live judged demo, a scripted replay is a liability: the moment a judge asks
"can you try a different goal," it's exposed as theater. This needs to become real.

### Design

- **`/plan` wiring**: replace the mockup's fake timeline with real `fetch('/plan', {
  method: 'POST', body: JSON.stringify({ goalText, walletAddress }) })` calls. Render
  whatever the real endpoint returns — real parsed goal, real plan, real validation
  errors if the plan fails (this should be shown, not hidden — a validation failure
  visibly caught and retried is a *feature* to show off, not a bug to paper over).
- **CORS**: `server.ts` needs `cors` middleware scoped to the frontend's origin (or
  `*` if the frontend and API are served from the same domain/proxy path — simpler,
  probably the right call here).
- **`/execute` endpoint — DECIDED: (b) deployed, hard-gated.** `/execute` runs on
  the VPS behind the real `waypoint.cjlin.com` domain, capped at the existing
  `MAX_STEP_USD` (already $2, likely lower for demo safety). The executor wallet is
  funded like a **faucet, not a treasury** — assume it gets drained by people poking
  at it from the internet, and plan a top-up cadence (before demo, and a buffer for
  during) accordingly, not a one-time deposit.
- **Deployment**: `backend/` (Express server) needs to actually run on the VPS —
  currently only the static frontend is deployed. New systemd service (mirroring the
  `waypoint.service` pattern already set up), reverse-proxied through nginx, `.env`
  with real API keys living only on the server, never shipped to the browser.
- **Responsive, not native**: considered a native mobile app, decided against it —
  not enough runway to build and get it in front of judges in this window, and it
  competes directly with the higher-value items below. Instead, make the existing web
  frontend responsive (works cleanly on a phone browser) — same page, no new build
  target, most of the cost is CSS layout work on what already exists.
- **Accounts, required — this is new scope**: since `/execute` is now real, public,
  and shared, and since memory (§2) needs a stable identity to key off, the app needs
  real accounts, not an anonymous shared session. `app.html` becomes two tabs:
  - **Login** — a real, authenticated session tied to one account, with persistent
    memory (§2) carried across visits and access to real execution.
  - **Try App** — unauthenticated. Proposed default (needs confirmation, see Open
    Questions): real `/plan` calls (real goal parsing + planning, live wallet reads),
    but no persistent memory and no `/execute` access — so a visitor gets the real
    planning experience immediately, with execution and memory as the reason to log
    in, not a locked demo.

### Trust model: how execution actually gets authorized (resolved after a real
back-and-forth on this — recorded here since the reasoning matters as much as the
conclusion)

Three separate concerns were getting conflated and needed separating: **(a)** account
login (who's talking to the app), **(b)** wallet linking (which addresses belong to
this account), **(c)** transaction signing authority (who can actually authorize a
transaction). Synapse's auth (`lib/memory/store.ts`: `users` table, scrypt password
hashing, OAuth) is a fine reference for (a), but doesn't touch (b)/(c) at all — Synapse
never has to move money, Waypoint does, and that's the part that needed real research
rather than assumption.

- **(a) Login**: SIWE (Sign-In With Ethereum) — a wallet signs a challenge message to
  establish a session. No password, coherent with "the wallet is the identity."
- **(b) Multi-wallet linking**: one account can have several linked addresses. Adding
  one beyond the first is a second signature — not a login, an explicit "link address
  X to account Y" message signed while already logged in — verified server-side,
  never a private key. Login later with *any* linked address resolves to the same
  account. Standard pattern (OpenSea/Zerion-style "add another wallet"), not novel.
- **(c) Execution authority — this is the one that took real investigation.** The
  naive answer ("connect a wallet, sign each transaction live") fails in two real
  ways: it's genuinely annoying with several linked wallets (constant manual
  switching in the wallet extension), and it **cannot work at all** for §3's
  conditional triggers — nobody is present to click "sign" when a health-factor
  trigger fires while the user is away, which is the entire point of that scenario.
  Three real options were investigated, not just assumed:
  - **Safe + Zodiac Roles Modifier** (mature, audited, the standard DAO-treasury
    delegation pattern) — **ruled out**: it only grants scoped permissions over
    assets *already held by a Safe contract*, not a plain EOA. A user with funds in
    a normal wallet would have to deploy a Safe and actually transfer assets into it
    — on every chain they hold assets on, since Safe is deployed per-chain. Real gas
    cost, real "my funds now live at a new address" friction, and it fights directly
    against Waypoint's actual pitch (read the users's *existing* multi-chain assets,
    not assets they moved somewhere new to use us).
  - **MetaMask Agent Wallet / Embedded Wallets** (TEE-secured key custody, built-in
    Blockaid simulation + threat scanning, spend limits — genuinely the closest
    product-market fit on paper) — **ruled out for this window**: still gated behind
    an Early Access signup as of this writing, no public self-serve API/SDK docs, and
    unclear from public documentation whether it binds to a user's *existing* funded
    EOA or provisions a new managed wallet. Worth revisiting post-hackathon once it's
    generally available and better documented; not something to gate the finals build
    on an unknown approval timeline.
  - **EIP-7702 session keys, via MetaMask's open-source Delegation Framework — the
    one we're building. Supersedes the ZeroDev plan below.** EIP-7702 (live on
    Ethereum mainnet since the Pectra hardfork, May 2025) lets a user's *existing*
    EOA gain smart-account capabilities with **no migration**: no new contract, no
    asset transfer, same address.
    - **ZeroDev was the original plan and was dropped.** Its bundler/paymaster
      infrastructure requires a paid dashboard project ($69/mo "Launch" plan) for
      *any* mainnet chain — the free tier is testnet-only. That's a real, confirmed
      finding (tested live against ZeroDev's own v3 RPC with our project ID across
      base/arbitrum/polygon/robinhood, all rejected; testnets on the same project
      worked immediately), not an assumption.
    - **`@metamask/smart-accounts-kit`** (the open-source SDK for MetaMask's
      Delegation Framework, MIT-0/Apache-2.0, npm-public, no signup/API key) replaces
      it entirely, at zero cost, on real mainnet, today. Its `DelegationManager.
      redeemDelegations()` is a plain external function (ERC-7710) — any relayer can
      call it directly as a normal transaction, so **no bundler and no paymaster are
      needed at all**; Waypoint's existing funded executor wallet just pays gas
      directly, exactly like it already does for every other transaction the
      orchestrator sends.
    - Caveat enforcers (MetaMask's name for session-key policies) map onto the same
      safety constraints ZeroDev's would have: `AllowedTargets`/`AllowedMethods`
      (restrict to specific contracts/functions), `ValueLte` (a cap — analogous to
      `MAX_STEP_USD`), `Timestamp` (expiration), `LimitedCalls` (throttling), plus
      several ZeroDev didn't have (`NativeTokenTransferAmount`, ERC-20/721/1155
      balance-change caveats, streaming/periodic transfer caveats).
    - **Verified for real, end-to-end, on Base mainnet — not just read from docs.**
      Two real proof transactions, both with real (small) ETH: (1) a throwaway EOA
      signed a 7702 authorization + a `NativeTokenTransferAmount`-scoped delegation;
      the relayer redeemed it in one transaction (activation + execution atomically),
      moved exactly the capped amount, and a replay attempt correctly reverted
      on-chain (`NativeTokenTransferAmountEnforcer:allowance-exceeded`). (2) The same
      mechanism executing a **real LI.FI-quoted swap** (arbitrary target + calldata,
      not just a plain transfer) via a `FunctionCall`-scoped delegation — this needed
      one real fix along the way: the natural-looking `NativeTokenTransferAmount`
      scope silently forces empty calldata (it's built for plain transfers only) and
      reverted the swap (`ExactCalldataEnforcer:invalid-calldata`) until switched to
      `FunctionCall` scope with the selector derived from the live quote. Balances
      verified by block-number-pinned reads (a live read right after the tx raced a
      lagging public RPC node and looked like nothing happened — same class of issue
      `orchestrator.ts` already documents and works around for its own balance
      checks).
    - **Open product question, not yet resolved — needs a decision, not more
      research:** browser extension wallets (MetaMask included) do not currently
      expose any RPC method for a dapp to obtain the raw EIP-7702 authorization
      signature (`viem`'s own `signAuthorization` explicitly only supports local
      accounts; the wallet-side method doesn't exist yet — confirmed via `viem`'s own
      GitHub discussion on the gap). Delegation *signing* (the EIP-712 caveat
      structure) works fine from any browser wallet via standard
      `eth_signTypedData_v4` — only the one-time 7702 authorization step is blocked.
      This means a real end user connecting their own MetaMask cannot (today) complete
      the activation step through our web app directly. Needs a decision on how the
      Try App / real-user flow handles this — options include a backend-controlled
      demo wallet for the Try App experience (real user assets stay unaffected),
      watching for wallet-side support to land, or something else. Left open
      deliberately rather than guessed at.
  - This same mechanism resolves the multi-wallet-execution annoyance too: each
    linked wallet does its **one-time** authorization independently; after that,
    the backend can execute within the granted policy on any of them without a live
    wallet-extension connection or manual switching.

### Effort

Large — grew from "wiring" to "wiring + a real accounts system + a real delegated-
execution layer (EIP-7702 + MetaMask Delegation Framework)". The orchestrator/
planner/deployment pattern is still reused unchanged for *building* transactions;
what's new is who's authorized to sign them, and that's genuinely new infrastructure,
not a config change. The mechanism itself (`src/delegation/delegation.ts`,
`src/delegation/store.ts`) is built and proven end-to-end on mainnet as of this
writing; what's left is wiring it into the orchestrator for multi-step plans and the
`/execute` endpoint (§ task list, blocked on the open product question above) — not
further verification of the delegation mechanism itself.

---

## 2. Memory layer

### Correction from the previous draft

The earlier version of this section was wrong on two counts, both corrected now:

1. **Wrong primary reference.** It cited Synapse's own README claim of "only two
   changes from upstream" as if that made Synapse a faithful stand-in for
   [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory). Pulled
   the actual upstream repo directly (not just Synapse's description of it) and the
   gap is much bigger than that: upstream is a full multi-service **Memory Hub**
   platform — `MemoryCore` + `MemoryHub` + `Proxy` as separate deployed services, four
   distinct asset types (Chat Memory, Skill, Wiki, CodeGraph), teams/roles/ACL,
   multi-agent "loadout" binding. That's built for teams of agents sharing curated
   experience, not a single hackathon agent. The correct move: go to the design of
   upstream's **Chat Memory** asset specifically (the one piece that's actually
   relevant here), and build Waypoint's own lightweight store that follows *that*
   design faithfully — not inherit Synapse's simplified description of it.
2. **Wrong call on multi-turn chat.** Waypoint *is* a multi-turn chat app, full stop —
   not an optional nice-to-have. A user can't always state a complete, unambiguous
   goal in one shot; the agent needs to be able to ask a clarifying question and
   continue the conversation. This directly changes §1 (frontend) too: `app.html`
   needs a real chat loop, not a single goal-in/plan-out request.
3. **Wrong call on L2/L3.** Keeping them, not cutting them. They're the layer that
   captures *how* a specific user operates — aggressive vs. conservative, which
   protocols they trust, how they react to risk — which then shapes better plans and
   better suggestions at execution time, not just fact recall. This is a real,
   lightweight "wallet/user profile," not a cut corner.

### Reference: upstream's Chat Memory design (read directly from
[Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory)'s
own README, not secondhand)

| Layer | What it stores | Primary use |
|---|---|---|
| **L0 Conversation** | Raw conversations with full context | Verify exact wording, timestamps, sources |
| **L1 Atom** | Facts, preferences, constraints, and events extracted from conversations | Precise recall of actionable information |
| **L2 Scenario** | Knowledge blocks organized around projects/scenarios | Quickly restore a working context |
| **L3 Core/Persona** | Long-term profiles, stable patterns, high-level cognition | Let the agent rapidly enter a user's context |

Retrieval is layered, not flat: **L2/L3 are the always-on quick context bootstrap**
injected on every turn; **L1/L0 are a fallback**, reached via BM25 + vector retrieval
+ RRF only when a specific fact is actually needed — and every result is capped by
item count, character budget, and timeout so memory never crowds out the actual
context window. (Benchmark upstream cites for this design: PersonaMem, 48% → 76% with
memory enabled, on whether an agent correctly understands and applies user
information after extended interaction.)

### Where Synapse actually fits

Not as the memory-design reference anymore — as proof that a **real multi-turn
agent chat loop** can be built well on Node/TypeScript: `lib/memory/chat-loop.ts`,
the `useChat` hook + `DefaultChatTransport` streaming pattern, session/message
persistence in `lib/memory/store.ts`'s `l0_conversations` table, and the
`scheduler.notifyTurn` trigger pattern (turn-count + mutex, no idle timers) for
running background extraction without blocking the chat response. This is exactly the
engineering Waypoint's `app.html` needs once it becomes a real chat interface instead
of a single-shot form, and it's already proven to work — reuse the *mechanics*, not
the memory schema.

### Adaptation for Waypoint

Scoped-down SQLite store (own implementation, not the upstream services — those are
real infrastructure to stand up, not justified for one agent in this window), keyed
by wallet address / account identity (see §1), following the L0→L3 layering above:

- **L1 Atom types** for Waypoint (facts/constraints/preferences, upstream's own L1
  definition): `gas_reserve`, `protocol_preference`, `chain_preference`,
  `risk_tolerance`, `recurring_goal`, `execution_outcome`.
- **L2 Scenario**: one block per recurring theme in a user's activity (e.g. "consolidating
  yield across Arbitrum/Base," "monitoring an Aave leveraged position") — aggregates
  the L1 atoms relevant to that theme, mirroring upstream's "restore a working
  context" purpose.
- **L3 Persona**: a short, continuously-updated profile — risk tolerance, chain/
  protocol habits, standing constraints — injected on *every* turn regardless of
  match, same as upstream's "always-on quick context bootstrap." This is the piece
  that lets the agent shape a plan's *style* (e.g. suggest a more conservative route
  for a user whose persona says conservative), not just recall isolated facts.
- **Extraction trigger**: after each completed turn/goal cycle (mirrors upstream's
  async-pipeline-after-conversation model, adapted from Synapse's turn-count+mutex
  mechanics), one LLM call, strict typed-JSON output per L1 atom type.
- **Recall**: L3 persona + relevant L2 scenario injected on every turn by default;
  L1/L0 fallback search (FTS to start — BM25/vector/RRF is upstream's fuller version,
  worth it only if time allows) only triggered when the current turn needs a specific
  remembered fact, capped by count/char-budget/timeout exactly as upstream specifies.

### Effort

Large — this is now genuinely two new subsystems, not one: the memory store itself
(L0–L3, correctly modeled on upstream this time), and the real multi-turn chat loop
in `app.html`/`server.ts` that the memory layer plugs into. Synapse's chat-loop code
is a real accelerant for the second piece.

---

## 3. Conditional / triggered execution — the autonomous-agent scenario

This is "Scenario 2" from the original `plan.md` (§5), explicitly deferred at the
time ("路线图展示，黑客松期间不实现"). Picking it back up now — it's the strongest
differentiation story: **the only scenario that proves the agent monitors and reacts
on its own, instead of "user asks once, agent runs once."**

### Why this matters (the pitch)

Large-capital users running leveraged/looped lending positions, or holding positions
in smaller/non-mainstream DeFi protocols without good native tooling, are exactly the
users most exposed to liquidation risk and least served by existing monitoring tools.
Real-time health-factor monitoring + automatic deleveraging is a concrete, valuable
capability for that audience — not a generic "AI agent" demo feature.

### Design

Reuses the existing pipeline almost entirely — the new pieces are small:

1. **Trigger schema** — extend `Goal` (`models.ts`) with an optional trigger shape:
   ```
   trigger: {
     metric: "aave_health_factor",
     chain: string,
     operator: "<" | ">",
     threshold: number,
     targetValue?: number,   // health factor to restore to, if applicable
   } | null
   ```
   `goalParser.ts` needs to recognize conditional phrasing ("if my health factor on
   Arbitrum drops below 1.3, repay debt until it's back above 1.8") and populate this
   instead of treating it as an immediate one-shot goal.

2. **New adapter — `adapters/aaveHealthFactor.ts`** — reads Aave V3's core `Pool`
   contract, `getUserAccountData(user)`, which returns `healthFactor` directly as one
   of its return values. Small, single view call — same "core contract, verified
   against the real deployed ABI" discipline already used for `aaveYield.ts`
   (`getReserveData`), not assumed from docs.

3. **Monitor loop — new `monitor.ts`** — a simple poller: for each registered
   trigger, on an interval, read the current health factor via the new adapter,
   compare against the threshold. On breach:
   - Synthesize a fresh goal at *trigger time* using real current state ("bring
     health factor from `currentHF` back to `targetHF` on `chain`") — **not** a plan
     pre-computed at registration time, since collateral/debt amounts will have moved
     by the time the trigger actually fires. This reuses `buildPlan` and `runPlan`
     completely unchanged.
   - No live user confirmation at fire time — the user pre-authorized this exact
     trigger when they registered it (matches `plan.md` §4.2's guardrail-layer note:
     "触发式场景可预先设置好确认策略"). Same simulate-before-sign, hard-USD-cap,
     stop-on-failure orchestrator safety rails apply unchanged.

4. **Registration surface**: simplest viable version is a CLI script or a `/trigger`
   POST endpoint that stores the trigger (wallet, condition, target) and starts/
   confirms the monitor is watching it. Doesn't need a full UI for the demo to be
   convincing — the monitor firing and executing for real is the point, not the form
   that registered it.

### Whose position the trigger fires on — updated now that §1 has a real answer for
delegated execution

Earlier drafts of this section assumed the trigger demo would have to run against
*our own* demo position, because there was no verified way for the monitor to act on
a real user's own funds without them being present to sign. §1 now has one — EIP-7702
delegation via MetaMask's Delegation Framework — so the target for the demo is a
**real logged-in user's own position**, authorized once via the same one-time
delegation flow as §1, not a separate mechanism, *once §1's open browser-wallet
question is resolved*. Keep the demo-position fallback as a safety net, not the plan:
if that isn't resolved and wired end-to-end by the time this needs to be locked in,
fall back to our own demo position (same custody model already established
elsewhere, zero new risk) rather than demoing unverified delegated execution on real
funds live on stage.

### The demo problem, and how to solve it honestly

Reliably crossing a real liquidation threshold live, on stage, in a 2-hour judging
window is not realistic — we can't control market prices, and manufacturing a real
thin-margin borrow position purely for rehearsal costs real collateral and gas every
run-through.

**Proposed solution — no faking the health factor itself, only the threshold
parameter**: register the trigger live with a threshold set *above* the position's
real current health factor (e.g. "alert/deleverage if HF < 5.0" against a real
position that's already sitting at, say, HF 3.0). The monitor reads the **real**
on-chain health factor and the **real** condition is **actually true** — it just fires
immediately because we chose an aggressive threshold on stage, which is realistic
(a cautious large-capital user might genuinely set a conservative early-warning
threshold like that). Nothing about the health-factor reading or the deleverage
execution is simulated or faked — only the threshold choice is picked for demo
timing, which is an honest, explainable choice if a judge asks about it directly.

**Chain choice — corrected**: the earlier draft framed this as "pick Arbitrum or
Base for the demo." Wrong framing — the priority is making sure **every chain
Waypoint already claims to support** (`base`, `arbitrum`, `polygon`, `robinhood` —
see `tokenRegistry.ts`) actually works reliably, not cherry-picking one known-good
chain for the trigger demo while leaving the others under-tested. Claiming support
for only a handful of chains and having bugs in *those* would be a much worse look
than not supporting more chains at all — this is §4 reliability work, not a §3 demo
scripting choice, and it should happen across the board, not just on whichever chain
the trigger demo ends up using.

### Effort

Medium. Reuses ~90% of existing infrastructure (goal parser, planner, orchestrator,
the Aave-core-contract-reading pattern). New surface area is genuinely small: one
schema extension, one small adapter, one poller loop, one registration entry point.

---

## 4. Reliability hardening (do last, before 5)

- **Verify every already-claimed chain actually works**, not just whichever one the
  live demos happen to use — `base`, `arbitrum`, `polygon`, `robinhood` (see §3's
  correction above). Re-run the real-transaction test matrix from Stage 1
  (`backend/README.md`'s "Verified" section) against each of the four, not just the
  Arbitrum/Base pairs already exercised.
- Retry / partial-failure recovery in `orchestrator.ts` (currently: any failure stops
  the whole run — by design, but a live demo benefits from at least a bounded retry
  on transient failures like RPC timeouts, not logic errors).
- Validate the `"output_of(step1) + output_of(step2)"` combined-expression gap
  documented in `backend/README.md`'s known limitations — currently silently skipped
  by the continuity checker.
- Morpho adapter, so "best-yielding protocol" is a real comparison across ≥2
  protocols, not just Aave by default.

## 5. Automatic bridge-vendor selection (cut first if short on time)

Planner currently always emits `vendorAdapter: "lifi"`; picking Relay requires
setting it manually. Compare quotes (cost/speed) and let the planner or orchestrator
choose — nice-to-have, not required for the core demo narrative.

---

## Decided (was open, now resolved)

1. ~~`/execute` exposure~~ — **deployed, hard-gated, faucet-funded** (§1).
2. ~~Memory persona/L3 layer~~ — **kept**, not cut; reframed as a real wallet/user
   profile that shapes plan style, not just fact recall (§2).
3. ~~Trigger demo chain/protocol~~ — **not a single-chain choice**; harden all four
   already-supported chains instead (§3, §4).
4. ~~Auth mechanism~~ — **SIWE for login/wallet-linking, EIP-7702 session-style
   delegation (via MetaMask's open-source Delegation Framework, not ZeroDev — see
   §1) for execution authority.** Reached after actually investigating delegated-
   execution options (Safe+Zodiac, MetaMask Agent Wallet, ZeroDev+ERC-4337, MetaMask
   Delegation Framework) rather than assuming — see §1's "Trust model" section for
   the full reasoning and why the others were ruled out. This also resolves the
   multi-wallet execution UX (one one-time authorization per wallet, no live
   switching needed) and gives §3's trigger scenario a real path to running on a
   user's own position instead of only a demo one — **once the open browser-wallet
   question in §1 is resolved.**

## Still open (need a decision before or during build)

1. **"Try App" (no login) scope** (§1): deliberately not deciding this yet — build the
   core functionality (accounts, memory, delegated execution, triggers) first, decide
   what the no-login experience shows once the real thing exists to show a limited
   slice of.
2. **How a real user's own browser wallet completes 7702 activation** (§1, new):
   confirmed no browser wallet currently exposes an RPC method for a dapp to obtain
   the raw EIP-7702 authorization signature — only local (server-held) accounts can
   produce it today. The delegation mechanism itself is built and proven; this is
   specifically about what a real connected-MetaMask user sees in the UI. Needs a
   decision, not more research.

## Verified (was "needs verification," now confirmed with real code and real mainnet transactions)

**MetaMask Delegation Framework** (§1) — not ZeroDev (see §1 for why that was dropped:
mainnet requires a paid plan). `@metamask/smart-accounts-kit` is open-source,
npm-public, no signup. Confirmed against the package's real installed source
(`node_modules/@metamask/smart-accounts-kit`) and MetaMask's own docs
(docs.metamask.io/smart-accounts-kit), then proven with two real transactions on Base
mainnet (`backend/test-delegation-e2e-tmp.mjs`, `backend/test-delegation-swap-tmp.mjs`,
`backend/src/delegation/delegation.ts`):

```typescript
// One-time EIP-7702 authorization (only works with a local/server-held account —
// see the open question above for what a real browser-wallet user sees instead)
const authorization = await delegatorWallet.signAuthorization({
  account: delegatorAccount,
  contractAddress: environment.implementations.EIP7702StatelessDeleGatorImpl,
});

// Caveat-scoped delegation. FunctionCall (not NativeTokenTransferAmount) is the
// scope for arbitrary contract calls — NativeTokenTransferAmount silently forces
// empty calldata and reverts real swaps (ExactCalldataEnforcer:invalid-calldata,
// found by testing, not obvious from the types).
const delegatorSmartAccount = await toMetaMaskSmartAccount({
  client: publicClient,
  implementation: Implementation.Stateless7702,
  address: delegatorAccount.address,
  signer: { walletClient: delegatorWallet },
});
const delegation = createDelegation({
  to: relayerAddress,
  from: delegatorSmartAccount.address,
  environment: delegatorSmartAccount.environment,
  scope: { type: ScopeType.FunctionCall, targets, selectors, valueLte: { maxValue: capWei } },
  caveats: [{ type: "timestamp", afterThreshold: 0, beforeThreshold: expiresAt }],
});
const signature = await delegatorSmartAccount.signDelegation({ delegation });

// Relayer redeems directly — DelegationManager.redeemDelegations is a plain
// external function (ERC-7710), no bundler/paymaster/EntryPoint involved. If not
// yet activated on-chain, authorizationList on this same tx does both at once.
const redeemCalldata = DelegationManager.encode.redeemDelegations({
  delegations: [[signedDelegation]],
  modes: [ExecutionMode.SingleDefault],
  executions: [[createExecution({ target, value, callData: data })]],
});
await relayerWallet.sendTransaction({
  to: environment.DelegationManager,
  data: redeemCalldata,
  authorizationList: needsActivation ? [authorization] : undefined,
});
```

Real proof transactions (Base mainnet): a capped native-transfer delegation that moved
exactly its cap and correctly rejected a replay
(`NativeTokenTransferAmountEnforcer:allowance-exceeded`); a real LI.FI-quoted swap
(SushiSwap Aggregator route) executed entirely through a `FunctionCall`-scoped
delegation, verified via block-pinned balance reads (0.00015 ETH in, 0.28593 USDC out,
matching the quote). Zero gas cost to the delegating account in both cases — the
relayer paid for everything.
