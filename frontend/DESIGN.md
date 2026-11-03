# Waypoint UI redesign: design spec

Scope: landing page (`index.html`) and the core app (`app.html`): Overview, Agent (chat), Wallets, Automations, Trusted calls. Backend, auth and all execution behavior are unchanged.

Method: the OilOil UI/UX guide (task-first hierarchy, state coverage, affordance, feedback loop closure, CRAP, spacing scale, help-text layering, UI copy source discipline). Style family `modern-minimal`, derived from Waypoint's own brand (cream paper, ink navy, signal blue) rather than a generic crypto palette.

References, and what is taken from each:
- Agama: warm paper ground, one deep accent, a single italic serif phrase inside a grotesk headline, one statement per screen, plenty of air.
- Aumo: grouped left navigation, breadcrumb plus large page title plus one-line description, hairline-bordered surfaces, an "agent online, N decisions recorded" footer as the trust device.
- Not taken: neon glow, glass, gradient washes, card walls, 3-column icon grids.

## 1. Principles

1. One job per screen. The primary action is identifiable in under 3 seconds.
2. Trust comes from facts, not decoration: real transaction hashes, real chains, what is custodial and what is not, stated plainly.
3. Quiet surfaces. Hierarchy comes from type size, weight and whitespace; borders are hairlines; no shadows, no blur.
4. Every state is designed: loading, empty, error, success, signed-out.
5. Copy describes the user's task, the system state, the result and the next step. No builder meta-text.

## 2. Tokens

Color (all derived from the brand; neutrals are warm, never pure grey):

| Token | Value | Use |
|---|---|---|
| `--paper` | `#F7F2E7` | page ground |
| `--surface` | `#FBF8F0` | raised panels, inputs |
| `--surface-2` | `#EFE9DA` | hover, inset rows |
| `--line` | `#E0D8C5` | hairlines |
| `--line-strong` | `#CBC1A8` | input borders, focus-adjacent |
| `--ink` | `#0B1020` | primary text, primary buttons |
| `--ink-2` | `#3A4156` | secondary text |
| `--ink-3` | `#5B6275` | tertiary text (5.6:1 on paper) |
| `--signal` | `#1B42D0` | the one accent: links, active nav, agent, focus ring |
| `--ok` | `#1D7447` | confirmed |
| `--warn` | `#8F5F0A` | pending, caution |
| `--danger` | `#B3321F` | failure, destructive |

Type: Inter for UI and numbers (tabular figures); Instrument Serif italic only as a single accent phrase in display headings; JetBrains Mono only for addresses, hashes and code.

| Role | Size / weight / tracking |
|---|---|
| Display (landing hero) | 64 / 500 / -0.035em, line-height 1.02 |
| Page title (app) | 32 / 500 / -0.02em |
| Section title | 15 / 600 |
| Body | 14 / 400, line-height 1.55 |
| Label / caption | 12 / 500, `--ink-3` |
| Mono | 12 / 450 |

Spacing scale (4 base): 4, 8, 12, 16, 24, 32, 48, 64, 96. Radius: 6 (chips, inputs), 10 (panels). Motion: 140 ms opacity and 4 px translate; no bounce.

Icons: 1.5 px line icons (inline SVG, Lucide-style). No emoji.

## 3. App information architecture

```
Workspace   Overview     what I own and what the agent is doing
            Agent        chat: state a goal, review the plan, confirm
Manage      Wallets      execution wallets (custodial), linked wallets (yours)
            Automations  DCA, health-factor repay
            Trusted calls  custom contract calls already approved
Account     (signed-in chip) · Agent status · Sign out
```

Signed-out users see one centered sign-in panel instead of an empty app with a form squeezed into a sidebar.

### Overview (new home, composed from existing endpoints)
Top: total value across all wallets and chains, with a one-line description. Below, three sections separated by hairlines rather than cards:
1. Holdings: table by chain and token (symbol, chain, amount, value).
2. DeFi positions: Aave supply / borrow / health factor per market.
3. Agent activity: automations with status, and recent conversations. Primary action: "Tell the agent what to do".

### Agent (chat)
Thread in the center (max 720 px), composer pinned at the bottom with a visible "Send". Right rail (wallet balances) collapses behind a "Wallets" toggle on narrow screens. Plan steps render as a numbered list on a hairline rail (not boxed cards); the Confirm button is the only filled button in the message.

### Wallets, Automations, Trusted calls
Same data and actions as before, restyled as titled sections with hairline-separated rows. Destructive actions (export key, delete automation) use text-danger buttons and keep their existing confirmations.

## 4. Desktop layout (>= 1024 px)

```
┌────────────┬───────────────────────────────────────────────┐
│ ▢ Waypoint │ Workspace / Overview                 [+ New]  │
│            ├───────────────────────────────────────────────┤
│ WORKSPACE  │                                               │
│  Overview  │  Overview                                     │
│  Agent     │  Everything you hold, and what the agent is   │
│ MANAGE     │  doing with it.                               │
│  Wallets   │                                               │
│  Automat.. │  $12,480.12      3 wallets · 5 chains         │
│  Trusted.. │  ─────────────────────────────────────────    │
│            │  Holdings                                      │
│ RECENT     │  USDC   Base      1,200.00        $1,200.00    │
│  chat …    │  ETH    Ethereum  0.0737            $198.00    │
│            │  ─────────────────────────────────────────    │
│ ● Agent    │  Positions · Activity …                        │
│ you@…  ⎋   │                                               │
└────────────┴───────────────────────────────────────────────┘
 240 px nav     content column max 880 px, 48 px gutters
```

## 5. Mobile layout (< 768 px)

```
┌──────────────────────────┐
│ ▢ Waypoint        [☰]    │  top bar 52 px
├──────────────────────────┤
│ Overview                 │  title 26
│ $12,480.12               │  hero number 34
│ 3 wallets · 5 chains     │
│ ───────────────────────  │
│ Holdings                 │  rows: symbol+chain left,
│ USDC  Base      $1,200   │  value right, 52 px tall
│ ETH   Ethereum    $198   │
│ …                        │
├──────────────────────────┤
│ Overview Agent Wallets ⋯ │  bottom tab bar, 56 px
└──────────────────────────┘
```

- The sidebar becomes a bottom tab bar (Overview, Agent, Wallets, Automations) plus a "More" sheet for Trusted calls, recent chats and sign out.
- Tables become two-line rows. Wallet rail and plan steps stack vertically. Composer sticks above the tab bar. Touch targets >= 44 px. No horizontal page scroll.

## 6. Landing page

Narrative: "Your personal onchain agent." Waypoint turns one plain-language goal into a checked, multi-step, cross-chain plan and carries it out from a wallet you control. It can run recurring jobs (DCA, health-factor repay) and shows every transaction it sent.

Structure (one statement per screen, no card grid):
1. Hero on faint grid paper (the brand motif): headline with one serif-italic phrase, one sentence, `Launch app` (filled) and `See how it works` (text link). A small "latest confirmed transaction" line is the proof.
2. How it works: three numbered rows (State the goal, Review the plan, Confirm once), each one sentence.
3. What it can do: a plain list of actions and the chains supported, including X Layer.
4. Control and custody, stated plainly: execution wallets are custodial and hands-free; linked wallets stay yours and sign each step.
5. For agents: `POST /asp/plan`, $0.02 per plan via x402 on X Layer, listed on OKX.AI. A short request/response example.
6. Footer: GitHub, Docs, X Layer / OKX.AI.

Claims are limited to what is built and verified.

## 7. State coverage

| Surface | Loading | Empty | Error | Success |
|---|---|---|---|---|
| Overview | skeleton rows | "No balances yet. Fund a wallet to start." | inline retry | values + timestamp |
| Chat | "Reading balances…" stage line | prompt suggestions | red inline message + retry | final result with tx links |
| Wallets / Automations | row skeleton | one sentence + primary action | inline message | row updates in place |
| Signed-out | n/a | centered sign-in | field-level error | redirect to Overview |

## 8. Checklist applied (hard rules)
Task-first hierarchy; state coverage; affordance (all clickables styled as links or buttons, icon-only controls have labels); error prevention (destructive actions keep existing confirmations); feedback loop (stage lines, tx links, toasts); consistency (one button system); CRAP; spacing scale; help-text layering (one helper line per section, advanced detail on demand); copy source discipline.
