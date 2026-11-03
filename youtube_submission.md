# YouTube Submission — Waypoint Demo

> Copy directly from this file (not from a chat window) to avoid list items getting
> dropped by clipboard/markdown mangling.

## Title

```
Waypoint — An AI Agent for On-Chain Goals (Hackathon Demo)
```

## Description

```
Existing natural-language on-chain agents already handle single pre-built actions — swap, bridge, swap+send. But they get stuck on dependency chains: bridge an asset cross-chain, then deposit it into a specific lending protocol. We tested this on Bankr Terminal and confirmed exactly where it stops — it completed the swap+bridge, then told us to finish the Aave deposit ourselves on Aave's frontend.

Waypoint is goal-driven, not command-driven. State a target end state in plain language, and it:

1. Reads your real balances across every chain you hold assets on
2. Parses your goal and plans the full multi-chain, multi-protocol dependency chain to get there
3. Validates the plan deterministically before anything is treated as executable
4. Shows it to you for confirmation
5. Executes it end to end — simulating every step before signing, capped at a hard safety limit, with each step's actual measured output driving the next

This isn't a mockup. The full pipeline — real on-chain state reading, real LLM planning, real execution — has been run end to end with real transactions on Arbitrum and Base mainnet, including the exact "bridge, then deposit into a specific protocol" scenario that stops today's agents.

Built with: TypeScript, OpenAI API, viem, LI.FI, Relay.link, Enso Shortcuts, Aave

Source code: https://github.com/dddgzeth/Waypoint

Built for NTU InnovateX Hackathon 2026.

#AIAgent #Web3 #DeFi #CrossChain #Hackathon
```
