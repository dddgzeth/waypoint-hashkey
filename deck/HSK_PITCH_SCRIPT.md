# Five minute online pitch

Deck: `Waypoint_HSK_Hackathon_Deck.pptx` (8 slides, same folder). Demo: a tour of the app, Overview, Wallets, an old chat, Automations, then the explorer. Say the lines in your own words, just keep the order and the timing.

## The plan

| Time | Where | What you do |
|---|---|---|
| 0:00 to 0:15 | Slide 1 | Open |
| 0:15 to 0:40 | Slide 2 | The problem |
| 0:40 to 1:05 | Slide 3 | How the agent works |
| 1:05 to 1:30 | Slide 4 | Why there is something to trade |
| 1:30 to 2:00 | Slide 5 | Risk |
| 2:00 to 4:00 | Live demo | Full product tour, 5 stops |
| 4:00 to 4:25 | Slides 6 and 7 | Product and onchain |
| 4:25 to 5:00 | Slide 8 | Close |

If you run over, trim slide 2 or 3. Never trim the demo.

## What to say

**Slide 1, open (15 seconds)**
"Hi everyone, we're Waypoint. We built an autonomous trading agent on HashKey Chain. You tell it your view in plain English and it trades on HashKey Swap by itself, inside limits it can't break."

**Slide 2, the problem (25 seconds)**
"Most trading agents today are either a black box or a script. With a black box, you never really know why it acted. With a script, you end up rewriting it for every new idea. And in both cases, the limits usually live in a prompt, which is a suggestion, not a real stop loss. We wanted an agent you can read, bound, and talk to."

**Slide 3, how it works (25 seconds)**
"Every minute, with nobody watching, the agent goes through six steps. It watches the pools and the market price. It works out the gap between them. It looks for a signal, and the model decides whether to take it. Then it trades, and finally it writes down what it did and why. The important part is that the model only owns step four. Everything around it is plain code."

**Slide 4, the edge (25 seconds)**
"So why is there something to trade at all? HashKey Swap is the only venue with real liquidity for these pairs, and its pools often sit a few percent below the market price. The agent buys when that gap is bigger than its costs. It exits when the gap closes, when a stop is hit, or after twelve hours. This is spread trading with hard exits, not magic."

**Slide 5, risk (30 seconds)**
"This is the part we care about most. The model can confirm an entry, shrink it, or skip it. That's all. It can't change the asset, it can't go above the size caps, and it can never hold back a stop loss. Order cap, position cap, two percent of pool depth, cooldown, daily loss limit. All of that is code, not a prompt. The model advises, and the code enforces."

**Demo (2 minutes, five stops, nothing typed or sent)**
Switch to the app. Walk the product in the order a user would meet it.
1. **Overview, 15 seconds.** "Let's walk through it like a user would. This is the account view, a demo account with the balances. Everything held on HashKey Chain is in one place."
2. **Wallets, 15 seconds.** "Next, wallets. The agent trades from an execution wallet. It signs by itself, so nobody has to sit there clicking confirm on every trade."
3. **Agent chat, 25 seconds.** Open an old conversation from Recent, the one that starts with `Start trading HSK`. "How do you set it up? One sentence in plain English, and you get a draft with every limit written out. Anything I don't say gets a safe default. You confirm, and it's running." Scroll to the draft card. Do not type anything.
4. **Automations, 45 seconds.** "This is the live panel. This table is the pool price against the market price, and the gap between them. When the gap is wide enough, the tag turns to buy zone. The agent waits for that line. And here's the part I like most, Why it acted. Every decision is written down with a reason, including the times it did nothing, like this one in cooldown." Point at one bought row and one blocked row.
5. **Live book, 20 seconds.** Click Live book. "Paper and live are two separate books, and they never mix. This is the live one, real money on HashKey mainnet, tiny size, two trades. Each fill has a link to its record in our contract." Click one onchain log link and show the explorer tab.

**Slide 6, product (25 seconds)**
"So that was the product. On one panel you get the gap for each asset, the limits, the positions, the fills, and the reasons behind every decision. You can look at it for ten seconds and understand what the agent is doing and why. Paper and live never mix, so you can test an idea before you use real funds."

**Slide 7, onchain (20 seconds)**
"One more thing. A live agent registers its rule and records each fill in our strategy log contract, which is deployed on HashKey mainnet. The contract holds no funds. It's just the record, so anyone can check what the agent said it would do against what it actually did."

**Slide 8, close (35 seconds)**
"To wrap up. Our goal is simple. You say the view, and Waypoint trades it, inside limits you can read, with a reason for every move and a record on chain. This is what an agent you can trust looks like. You can try it at waypoint.cjlin.com. Thank you, and we're happy to take questions."

## Before you go online

- Rehearse once with a timer. If it runs long, trim the slides, not the demo.

## What not to say

- Don't say "risk free", "arbitrage", or "profitable". The real results are small losses from fees, and the strength here is explainability, enforced limits, and an onchain record.
- If someone asks about the P&L number on slide 6, say that slide is an illustration of the panel, and the real numbers are in the live demo.
- Don't promise other chains or protocols. This pitch is about HashKey Chain.
