# Demo script: the HashKey trading agent (3–5 minutes)

Mode: **paper** (fills at live HashKey Swap quotes, nothing is sent). Everything on screen is real data.

## Before you start (2 minutes, off camera)
1. Backend: `cd backend && npx tsx src/server.ts` (port 8787). Frontend: `cd frontend && python3 -m http.server 5180 --bind 127.0.0.1`.
2. Open `http://127.0.0.1:5180/app.html`, sign in with the demo account, select the **Execution wallet** in chat.
3. Let the sampler run ~2 minutes so the panel has fresh readings. Open **Automations**: the HashKey agent panel should show a gap per asset.
4. Check the gap on the HSK row. The agent buys when it reads **-3% or lower** ("buy zone" is shown next to the number). If the HSK gap is smaller than that, use the fallback at the end.

## The flow

| # | You do | The viewer sees | Say |
|---|---|---|---|
| 1 | In chat type: `Start trading HSK on HashKey, 20 USDT per trade, low risk` | A draft card: mode, assets, 20 USDT per trade, risk low, loss limit 20 USDT. | "One sentence sets the rules. Anything I don't say keeps a safe default." |
| 2 | Click **Confirm & enable** | "Enabled…" and, within a minute, a chat message when the agent acts. | "From here nobody is clicking. It checks every minute." |
| 3 | Type: `switch to paper trading` and confirm | A draft where only the mode changed. | "Only what I mention changes. Paper mode fills at live quotes without sending anything." |
| 4 | Open **Automations** | The panel: the strategy sentence, Limits, **Today's loss budget** bar, and the table of pool vs market gap per asset with a "buy zone" tag. | "This is what it looks at: the pool is cheaper than the market by this much, and this is the line where it starts buying." |
| 5 | Point at **Positions** and **Total P&L** | A position with quantity, average cost, unrealized P&L. | "It opened a position when the gap was wide enough, sized by the risk rules, never above the caps." |
| 6 | Point at **Why it acted** | Lines like `bought HSK … (spread_entry). <model rationale>` and `blocked … In cooldown`. | "Every decision is written down, including the ones where it did nothing and why. The model can shrink or skip an entry; it cannot override the limits." |
| 7 | Type: `stop for the day after losing 10 USDT` and confirm | Draft with the daily loss limit 10; after confirming, the loss budget bar reads "of $10.00". | "Risk limits are code, not model opinion. At 10 USDT lost, it stops opening positions for the day." |
| 8 | (Optional) Type: `only trade ETH` | Draft with assets ETH only. | "Retuning keeps positions and history." |
| 9 | Click **Live book** | The real round trip: a 5 USDT buy and its sell, each with an explorer link and an **on-chain log ↗** link into our `WaypointStrategyLog` contract. | "Paper and live are separate books. This is the same agent trading real funds on HashKey mainnet and recording each fill on-chain." |
| 10 | Click **Paper book** again | Back to the simulated book; the panel refreshes by itself every 20 s. | — |

Close with: "A live agent signs the same fills from the user's own execution wallet and records them in our `WaypointStrategyLog` contract on HashKey Chain." Show the fills table: the two live rows from the 2026-11-03 test (a 5 USDT buy and its sell) each carry an explorer link and an "on-chain log" link. The paper rows above them have no transaction, by design.

## Fallback if no signal is firing
- The panel always shows the live gap per asset. Say: "The agent only trades when the pool is cheaper than the market after costs. Right now the gap is X%, so it waits. That patience is the product." Then point at the **Why it acted** log and any earlier fill or skip.
- Pre-seeding is done by running the agent in paper mode ahead of time, not by editing data: start it at least a few hours before the demo so that a position and its decisions already exist. A position closes only when the gap narrows to the exit level, a stop-loss triggers, or the 12-hour holding limit passes.
- Do not lower the entry threshold on camera to force a fill unless you say so; the honest framing is that the thresholds are tunable ("be more aggressive") and the default is conservative.

## Things not to claim
- Not risk-free arbitrage: HashKey Swap has no second venue for these pairs, so this is spread trading with a stop and a loss limit.
- Paper mode sends no transactions and writes nothing on-chain.
