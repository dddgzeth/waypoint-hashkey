# Waypoint on HashKey Chain: AI Agent Trading

**Track:** AI Agent Trading (HSK Chain Horizon Hackathon, Mumbai Edition)
**One line:** Tell the agent your trading view in plain language. It trades on HashKey Swap, and a stop-loss / take-profit rule keeps working without you.

## What it does
An AI trading agent that runs on its own against HashKey Swap, inside limits the user sets in chat.

**The loop (every minute, no one present)**
1. **Watch.** Reads each pool's marginal price from its on-chain price state, the market price from CoinMarketCap (OKX cross-check for ETH), the pool's depth, and the last hour of swap flow from the pool's events. Every reading is stored; the agent starts with a day of history rebuilt from the chain's archive state.
2. **Analyse.** The pool-versus-market gap, the price's z-score against its own day, and the estimated slippage of the order it would send.
3. **Find signals.** A *spread entry* (pool at least N% below the market, with the edge left after two pool fees, slippage and a safety buffer still positive) and a *mean-reversion entry* (z-score at or below -2 with the pool below the market). Exits: gap closed, stop-loss, maximum holding time.
4. **Decide.** The model confirms or skips each entry and sizes it from the evidence (idle pool, flow, depth, slippage). It cannot change the asset or side, and cannot go above the size the risk rules allow. Risk-cutting exits (stop-loss, timeout) never wait for the model.
5. **Risk framework (hard-coded).** Order cap, per-asset position cap, order at most 2% of the pool's depth, minimum order, cooldown per asset, and a daily loss limit that stops new positions for the day.
6. **Trade.** Straight to HashKey Swap's SwapRouter02 through the simulate-then-send pipeline, signed by the user's execution wallet.
7. **Record.** Every fill goes to a ledger with cost basis, realized and unrealized profit, the signal that fired and the reason given; the Automations page shows each pool's gap to the market against the buy threshold, the active limits, today's loss budget, positions, P&L, fills with explorer links and a "why it acted" log (skips and blocked orders included, with their reasons).
8. **Optional on-chain log.** When a `WaypointStrategyLog` address is configured (it is, on mainnet), a live agent registers one rule per asset and records each live fill in the contract from its own execution wallet, in the background, so a failed log write never affects a trade. Paper mode never touches the chain. With no address configured the agent behaves exactly as without it.

**Talking to it.** "Start a trading agent on HashKey for HSK and ETH, 20 USDT per trade, low risk", "only trade ETH", "stop for the day after losing 10 USDT", "switch to paper trading". Only the settings mentioned change; the agent keeps its positions and history. A paper mode fills at live quotes without sending anything.

**Also:** a stop-loss / take-profit rule for a HashKey position ("sell half my HSK if it drops to 0.07 USDT"), and `WaypointStrategyLog`, a no-funds contract that records strategies and executions on HashKey Chain.

**What the market looks like.** HashKey Swap is a small venue: three pools have real liquidity (WHSK/USDT about $436k, WETH/USDT about $48k, WBTC/USDT about $50k). The opportunity the agent trades is the gap between those pools and the wider market: on the day of the latest check (2026-11-03) the WHSK pool sat about 3.8% below the CoinMarketCap price while the WETH pool was within about 1.5% of it. This is spread trading with a loss limit and a stop, not risk-free arbitrage.

## Verified so far
- Chain config, balances (with USD values for HSK and the main HashKey tokens), and swap transactions for HSK and USDT against mainnet state.
- Pool price from price state, market price, depth, flow, and a 24-hour history rebuilt from archive state.
- **Paper mode** through the real trigger monitor: real signals, model-sized entries, risk checks, cooldown blocks, a converged exit, ledger and P&L (2026-11-03).
- **Live mode on HashKey mainnet, 2026-11-03**, with a 5 USDT order through the real monitor: the agent registered its rule on-chain, approved USDT to SwapRouter02, bought 56.9588 WHSK for 5 USDT (`0x69833ce650c95464d6f872e75c725dc16d87af46d732ac3115366532d1c2486d`), then sold it for 4.97 USDT on the converged-exit signal (`0x4bb25d91ac200d42b6812a38834f59466f13f2419774771134e8427d40a79c63`). The 0.03 USDT difference is pool fees and slippage. Live and paper results are reported separately. For this test the entry gap was lowered to 2% and the exit line raised to 2.9% so the real quotes would trigger a round trip, and the model step was off; the defaults are 3% and 0.5%.
- **`WaypointStrategyLog` deployed on HashKey Chain mainnet** at `0xa7398d137034683ad70cce94ef2ea77429873a9a` (deployment tx `0xa87fb0d357b7170ed177d562156ab549c6552de5e6684bf10d193ed06792eecd`). The live run wrote one `StrategyRegistered` and two `ExecutionRecorded` events to it (txs `0xdbbd65151bf4ee3507cd2e84d210e6c974e33628e685bbe538c343b4504597ea`, `0x53d380f522f60d5011ee1cef7e8d2a2b911fafca36871c05a36b121cee43697b`, `0xa4450af4345c2f241e94f034695eb20547a7be28b0cd725e3382cc953e857819`), and the panel links each fill to its log transaction. A dry-run test also covers the owner-only checks.
- The authenticated `GET/POST /hashkey/agent` routes, pause / resume / check, and the Automations panel (gap per asset against the buy threshold, limits, today's loss budget, positions, fills with explorer links, "why it acted"), checked in a real browser.
- Chat starting and retuning the agent: 12 of 12 draft parses over four prompts changed only the settings mentioned; the chat flow (draft, confirm, panel update) was run in the UI. A stop-loss / take-profit rule ("sell half my HSK into USDT if it drops to 0.05 or rises to 0.2") parses, is created, and the monitor reads the pool price each minute without firing.
- The agent's own stop-loss: with the stop tightened to 0.1%, an open position was closed by a forced `exit_stop` sale without going through the model.
- Paper and live are separate books: trades, positions, P&L, cooldowns, today's loss budget, the decision log and the on-chain log never mix, and the panel switches between them.
- An execution wallet signs HashKey Chain transactions (Privy).

## HashKey contracts used
| | Address |
|---|---|
| SwapRouter02 | `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3` |
| QuoterV2 | `0x1095A23A4812185344D9abd5143191D8a3A7E36f` |
| UniswapV3Factory | `0x972cA9D1662F5e029cD18327D29026532E84c742` |
| WaypointStrategyLog (ours) | `0xa7398d137034683ad70cce94ef2ea77429873a9a` |
| WHSK | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` |
| USDT | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` |

## Code
- `backend/src/chains/hashkey.ts`: the chain.
- `backend/src/providers/hashkeyswap.ts`: the swap provider and price reads.
- `backend/src/hashkey/`: the trading agent (`market.ts`, `signals.ts`, `risk.ts`, `decision.ts`, `agent.ts`, `ledger.ts`, `strategy.ts`).
- `backend/src/triggers/priceExit.ts` and `monitor.ts`: the stop-loss / take-profit rule and the agent's scheduler.
- `backend/src/hashkey/WaypointStrategyLog.sol` and `deploy.ts`: the strategy contract and its deployment.
