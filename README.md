# Waypoint on HashKey Chain

An autonomous trading agent for the HSK Chain Horizon Hackathon, Track 1 (AI Agent Trading).
You describe a view in plain English. The agent watches HashKey Swap against the market price, trades the gap,
and stays inside limits that are enforced in code. The model can confirm, shrink or skip an entry; it cannot override a limit.

- `backend/` Express + TypeScript server. The HashKey agent lives in `backend/src/hashkey/`.
- `frontend/` the web app (`app.html`).
- `backend/src/hashkey/WaypointStrategyLog.sol` the on-chain strategy log contract, deployed on HashKey Chain mainnet.
- `HSK_SUBMISSION.md` the submission write-up. `deck/` the pitch deck.

Run locally: copy your own keys into `backend/.env` (see the variable names used in `backend/src`), then
`cd backend && npm install && npx tsx src/server.ts`, and serve `frontend/` on any static server (`frontend/dev-server.mjs` works).
No keys, wallets or databases are part of this repository.
