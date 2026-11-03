# Devpost Submission — Waypoint (English)

> Matches the actual Devpost form field-by-field. Copy each section into its corresponding field. Items marked `[TODO]` need info only you have (repo URL, team roster, etc.) before submitting.

---

## General info

### Project name
*(60-character limit)*

```
Waypoint
```

### Elevator pitch
*(200-character limit — provide a short tagline)*

```
Waypoint is an AI agent for on-chain goals: state what you want, it plans the full multi-chain, multi-protocol path to get there, validates it, and runs it end to end.
```

---

## Project Story

### About the project
*(Markdown, LaTeX supported. Cover: what inspired you, what you learned, how you built it, challenges faced.)*

```markdown
## Inspiration

Existing natural-language on-chain agents — Bankr being the clearest example, a live
production product with real trade volume — already handle pre-built combo intents:
swap, bridge, swap+send, cross-chain swap. We wanted to know exactly where that stops,
so instead of guessing we tested it ourselves on Bankr Terminal (2026-08-12): "swap ETH
to USDC on Base, bridge it to Arbitrum, then supply it into Aave to earn yield." Bankr
completed the swap+bridge automatically — real on-chain transaction — then stopped cold
at the third step. Its own reply: "no one-click tool yet for direct Aave deposit — you
can supply it yourself on Aave's frontend." Separately, Bankr's own official account has
publicly acknowledged a single-turn step limit, telling a user to split a multi-step
request into separate messages. The underlying settlement infrastructure for cross-chain
movement is already mature (NEAR Intents: $20B+ cumulative volume; ERC-7683 adopted by
Across, LI.FI, UniswapX). What's missing isn't execution primitives — it's who plans the
full dependency chain across them.

## What it does

Waypoint is goal-driven, not command-driven. Instead of issuing instructions one step at
a time — swap this, now bridge that, now deposit this — the user states a single target
end state in plain language: "consolidate my assets into ETH and put it into the
best-yielding lending protocol on Arbitrum." Waypoint reads the user's real balances
across every chain they hold assets on, plans the full dependency graph needed to get
from where they are to that target state, shows the plan for confirmation before
anything moves, then executes it end to end. That includes exactly the kind of step — a
specific protocol deposit following a cross-chain move — that stops today's chat-first
agents cold and hands the task back to the user.

## How we built it

The core is a five-layer TypeScript pipeline, and every layer runs against real
infrastructure, not mocks:
- **State reader** — real on-chain multicall reads across every chain the wallet holds
  assets on (native balance plus that chain's dollar stablecoin), so planning always
  starts from the wallet's actual current state, not a stale snapshot.
- **Goal parser** — OpenAI structured output turns free-text plus the user's current
  wallet state into a structured goal, deliberately kept separate from execution details
  so an LLM hallucination can't directly touch how funds move.
- **Planner** — an LLM proposes a step-by-step dependency graph, informed by a live
  on-chain yield lookup (read directly from a lending protocol's core contract, not a
  cached rate) when the goal needs one; deterministic code then validates the proposal
  (supported chains/protocols, no-op step detection, chain/token continuity between
  dependent steps, action-type consistency, malformed amount fields) before anything is
  treated as executable. A failed validation feeds back into a retry loop with the
  specific failure reason attached, rather than silently returning a broken plan.
- **Orchestrator** — the execution-time state machine, and the layer we were most
  careful with: every step is simulated before it's ever signed, every step's dollar
  value is checked against a hard cap before simulation even runs, steps run strictly in
  order and a failure stops the whole run rather than continuing on uncertain state, and
  the amount fed into a dependent step is that step's *actual measured output* — read
  from its own transaction receipt, or for a cross-chain step, confirmed via the
  bridge's own delivery-status endpoint — never the plan's estimate. Two bridge vendors
  and one same-chain execution vendor are wired up underneath; none of them is a
  permanent dependency the planner is locked to — the planning and validation layers
  above are what's actually novel here.
- **Plan confirmation** — showing the plan isn't a binary yes/no gate. A user's reply
  is classified along two independent axes — what kind of action they're taking
  (confirm / modify / add a constraint / flag a risk concern / state looks wrong) and
  what part of the plan they mean (the goal, a balance, a specific step, a protocol
  choice) — and routed accordingly (re-plan just one step, fold in a new constraint,
  refresh stale balance data, etc.) instead of hard-coding a response for every possible
  phrasing.

## Challenges we ran into

- **LLM planning bugs weren't the obvious kind.** Repeated end-to-end runs surfaced a
  no-op same-token "swap," broken chain/token continuity between dependent steps, and
  cross-chain actions mislabeled as same-chain — none catchable by a plan that just
  "looks reasonable." Fixed with a deterministic validator plus a retry-with-feedback
  loop.
- **Real execution exposed a second wave of bugs planning tests couldn't reach.**
  RPC-lag caused a false "0 received" on a successful swap (fixed by reading the
  transaction's own receipt logs); a cross-chain delivery turned out to be invisible in
  our own receipt (fixed by polling the bridge's status endpoint). The first real
  LLM-generated plan even broke the orchestrator with a malformed amount field — no
  funds moved, but it proved schema-valid and executable are different bars.

## Accomplishments that we're proud of

We tested the competitor gap ourselves, live, rather than assuming it. The pipeline runs
fully end to end with no hand-written plan in between: real goal parsing, real planning
with a live on-chain yield lookup, and real execution — verified with real transactions
on Arbitrum and Base mainnet for the exact scenario the competitor fails at. Every step
is simulated before signing, capped at a small dollar amount, and driven by real
measured output, not an estimate.

## What we learned

Real testing beats assumption at every layer — what a competitor can't do, what an LLM
planner gets wrong, and what an LLM-generated plan breaks on at execution time are only
knowable by actually running it, not by reasoning on paper.

## What's next

More protocols beyond the current scope, retry/failure recovery, and conditional
triggers (e.g. auto-deleveraging before a liquidation). Alongside that, a memory layer
that remembers a user's operating habits across sessions and uses them to correctly
parse longer, more compound goals.
```

---

## Built with
*(up to 25 tags)*

```
TypeScript, Node.js, OpenAI API, Zod, Express, viem, LI.FI, Relay.link, Enso Shortcuts, ERC-7683, Across, NEAR Intents, Aave
```

---

## "Try it out" links

```
https://github.com/dddgzeth/Waypoint
https://www.youtube.com/watch?v=J27PTVV5Pks
```

---

## Project Media

*(Image gallery — JPG/PNG/GIF, 5MB max, 3:2 ratio recommended, up to 15 images)*

Suggested images to prepare and upload here:
- A frame/screenshot from the demo video (e.g. the dependency-graph mechanism frame)
- The architecture diagram from `plan.md` §4 (exported as an image)
- `logo/final/waypoint-logo-lockup-large.png` or a light-background export of it
- Screenshots of `supporting-materials/waypoint-flow-demo.html` (a static one-page
  walkthrough of the 5-layer pipeline with real Arbitrum/Base mainnet transaction
  evidence — open it in a browser and screenshot the sections, or attach the HTML file
  itself under Additional info's file upload)

The finished demo video itself (`renders/video.mp4`) uploads as the video field, not here.

---

## Additional info
*(For judges and organizers — not shown on the public project page unless noted)*

### Upload a File
*(zip/pdf/word/apk, 35MB limit — bundle multiple files into one zip)*

```
Zip the contents of the waypoint-submission/ folder (same content as the public GitHub
repo linked above) and upload as one .zip here.
```

### Project name
```
Waypoint
```

### Track
```
Web3 Applications, AI Agents and Real-World Use Cases
```

### Team Type
```
[TODO — confirm Public Group or Student Group; if Student Group, every member needs
proof of current student status attached to the uploaded file above]
```

### Team member list
*(Format: Name (University/company/organization); separate multiple members with semicolons)*

```
[TODO] e.g. Jane Doe (Nanyang Technological University); John Smith (Independent)
```

### Primary Contact Email
```
a903778821@gmail.com
```

### Project description
*(Internal, for judges only — this is a separate Devpost field from "About the project"
above, not a shorter restatement of it. Use it for the more technical, judge-facing
detail that doesn't belong in the public narrative.)*

```
Waypoint's planning layer is provider-agnostic by design: real on-chain state reads plus
OpenAI structured output turn free text into a structured goal; an LLM proposes a
step-by-step dependency graph, informed by a live on-chain yield lookup when relevant;
deterministic code validates it (supported chains/protocols, no-op step detection,
chain/token continuity between dependent steps, action-type consistency, malformed
amount fields) before any step is treated as executable, with a retry-with-feedback loop
on failure. Only after that validation does a step get routed to an execution primitive
— for this MVP, two cross-chain bridge vendors and one same-chain multi-protocol vendor,
chosen for mature, audited settlement rather than reinventing bridges or protocol
integrations, but not a fixed dependency the planner is locked to.

What differentiates this from a thin LLM wrapper around an existing intent-execution API
is exactly that validator, and the orchestrator built on top of it: during testing the
validator caught concrete bugs a model actually produced (a no-op same-token "swap,"
broken chain/token continuity between two dependent steps, a cross-chain action
mislabeled as same-chain, a malformed amount field), and the orchestrator's own design
was shaped directly by bugs only real execution exposed (RPC-lag false negatives on
output measurement, a cross-chain delivery that never appears in the source chain's own
receipt). Every step is simulated before signing and capped at a small fixed dollar
amount. This whole loop — natural-language goal in, no hand-written plan, real on-chain
execution out — has been run end to end with real transactions on Arbitrum and Base
mainnet, for the exact scenario the "Inspiration" section documents a leading production
competitor (Bankr) failing at: a cross-chain bridge followed by a deposit into a specific
lending protocol. We tested that competitor live on 2026-08-12 and confirmed, from its
own response, exactly where it stops.
```

### URL to your open source and public code repository
```
https://github.com/dddgzeth/Waypoint
```

### URL to your functional demo application
```
No hosted demo app — this is a backend agent, not a web app. The demo video
(https://www.youtube.com/watch?v=J27PTVV5Pks) and the flow-demo page in Project Media /
Additional info demonstrate the working backend pipeline (goal parsing -> planning ->
real execution) instead, including real Arbitrum/Base mainnet transaction hashes.
```

### Uploaded file description
```
Zip of the project repository. Contents: README.md (problem, solution, architecture,
verified results); backend/ (the full TypeScript source — state reader, goal parser,
planner, orchestrator, vendor adapters — with every verified mainnet transaction hash
documented in backend/README.md); frontend/index.html (a static UI mockup replaying one
real verified session); demo-video/ (the same explainer uploaded as the video field);
supporting-materials/ (architecture diagrams, a flow-evidence walkthrough page, and
screenshots); logo/ (branding assets).
```

### Eligibility
```
[ ] Confirm you and all teammates meet the eligibility requirements in the official
    hackathon rules before submitting.
```
