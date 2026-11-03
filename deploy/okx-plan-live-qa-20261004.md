# Waypoint Plan: production payment regression report

## Follow-up: rejection reproduced at the review boundary, 05:35–05:43 UTC

The 05:30 UTC submission was rejected with the same message. The original
passing tests below did not prove reviewer compatibility.

New evidence:

- Nginx logged Java-client POSTs receiving 402 at 05:29:51 UTC and 422 at
  05:30:02 UTC. The original access log had neither request bodies nor payment
  header presence, so those entries do not prove a paired, settled payment.
- A live challenge advertised `http://waypoint.cjlin.com/asp/plan`, despite the
  HTTPS endpoint. The SDK inferred the URL from Express's internal HTTP request.
- Bazaar v2 `info.input.body` incorrectly contained a JSON schema rather than
  example values; the schema also lacked the `input.body` carrier nesting.
- Prepared-plan cache keys included client IP. A proxy/egress change could
  trigger new model validation between probe and paid replay.

Fixes deployed at approximately 05:41:49 UTC:

- Explicit HTTPS `resource` URL, configurable via `ASP_PUBLIC_URL` and validated
  against HTTP, embedded credentials, query and fragment.
- Correct Bazaar v2 info/schema shapes, checked against the upstream HTTP
  `createBodyDiscoveryExtension` implementation.
- Cache by normalized goal and wallet, independent of request IP; preparation
  rate limits still apply per client. This is a public stateless planning API.
- Allowlisted `[asp/audit]` logs: request ID, body/field types, canonical input
  hash, payment-header presence, status, cache outcome, failure stage,
  challenge/settlement flags and latency. No raw prompt, address, cookie,
  authorization value or payment signature is logged.

Source SHA-256: `bad25ce26d5e43f06e8cd9162587a901bc2463919ffadd36547ea6420f0b6760`.
Backup: `/opt/Waypoint/backups/20261004-discovery/`. Local type checking and
VPS build passed. Tests increased to 15, all passing. All 20 production unpaid
tests passed again, now asserting the actual HTTPS resource and Bazaar structure.

Official Onchain OS `payment quote` → Agentic Wallet `payment pay` auto-replay
also returned the plan successfully, without our custom Privy test harness:

- Before follow-up fix: `0xc89e76b32f0e2b4a3330c1def6613b30f2934a12674dbb8876caf5c39b52ad37`,
  receipt success, block 72323415.
- After follow-up fix: `0x0809b197657f0b87697118442e62f76168aa6ecf179d0984bb02239bfcf36ecd`,
  receipt success, block 72323530.

These two official-client payments use the logged-in owner/agent wallet, which
is also the recipient; each authorization is 0.02 USD₮0 and these are self-payment
interop tests. The earlier three distinct-payer tests establish net transfer.
Both official-client receipts were independently checked using Alchemy RPC.

This proves the official client can complete the advertised request; it does not
yet identify the exact reviewer input or prove the latest review is approved.

The follow-up submission succeeded around 05:43 UTC. Nginx and application audit
logs then showed Java-client requests at 05:43:01 and 05:43:03 UTC: first 402,
then signed 200 with settlement, same canonical input hash
`9f4647fe93412d597730`, cache hit. The signed request audit ID is
`68bf2833-ded8-4f7c-be41-8639c7fef49c`. These are strong evidence of successful
review-window replay, though the client UA alone cannot authenticate its owner.
OKX still reports review in progress. No approval claim yet.

---

Tested on 2026-10-04, 05:28–05:29 UTC (13:28–13:29 Singapore).

## Deployment

- Host: `195.7.7.17`, SSH port `22011`.
- Endpoint: `https://waypoint.cjlin.com/asp/plan`.
- Changed production source: `/opt/Waypoint/backend/src/asp.ts` only.
- Source SHA-256: `3a6d6ba3a7d85a67d0d84a1dca695a77a863e799df12bd415b06a7b3886c916f`.
- Compiled `dist/asp.js` SHA-256: `bd239d49d2fd91a66f49adb37386a45a2d08bc9dc6b0ef636fd857a11d2c535f`.
- Backup: `/opt/Waypoint/backups/20261004-full-prepayment/{asp.ts,asp.js}`.
- VPS `npm run build` exited successfully before restart. No ignored build errors.
- Local Node 22 type check and all 11 `tests/asp-payment.test.ts` tests passed.
- An immediate request during restart returned 502. After the listener started,
  `/health`, homepage and `/app.html` returned 200 and the full suite passed.
- No accounts, balances, application UI, chat logic or automation configuration were modified.

## Unpaid HTTP tests

All 20 cases passed against production using `backend/tests/asp-live.ts unpaid`.

| Input | Expected and observed | Payment challenge |
|---|---|---|
| Bare POST, `{}` | 402 | Yes |
| Null, empty, numeric, array, short, punctuation-only, overlong goal | 400 | No |
| Invalid or null wallet; array request root | 400 | No |
| Malformed JSON | 400 | No |
| Plain-text body | 415 | No |
| URL query and URL-encoded form with the example goal | 402 | Yes |
| Conflicting query/body goals | 400 | No |
| `make me some money onchain` | 422, clarification | No |
| `Bridge 5 USDC from Base to Dogecoin` | 422, clarification | No |
| GET descriptor | 200 | No |

Default cold preparation + challenge: 6.716 seconds. Cached probes: approximately
0.2–0.8 seconds. These are observed latencies, not a marketplace timeout guarantee.

## Real onchain settlement

Buyer: `0x4ffa3175f9d2c71531a107c40b3b7a8543b9ec29` (existing authorized Privy test wallet).

Seller: `0x7a80299a84c3775d62da1cd4a9d59b1524d7bf0f`.

Network: X Layer, `eip155:196`.

Asset: USD₮0, `0x779ded0c9e1022225f8e0630b35a9b54be713736`, 6 decimals.

Each challenge was checked for exact scheme, network, asset, recipient and
`amount=20000` before signing. Each test then sent an invalid `goal:null` with
the signed payment header: production returned 400 without a challenge or
settlement header and the buyer's balance stayed unchanged. The same unspent
authorization was then used for the intended valid request.

| Case | Preparation/probe | Paid replay | Returned resource | Settlement block |
|---|---|---|---|---|
| `default` (`{}`) | 0.647 s, cache hit | 200, 1.143 s | Demo-labelled 100 USD₮0 Aave supply plan | 72322677 |
| `wallet` | 7.550 s | 200, 0.889 s | Real-wallet 0.1 USD₮0 → USDC swap plan | 72322693 |
| `crosschain` | 7.650 s | 200, 0.880 s | Demo-labelled Base → X Layer 20 USDC bridge, then Aave supply dependent on step 1 | 72322709 |

Transaction hashes:

1. Default: `0x79f1a52eac04c083848babe34f28f32358e67997e19467755b78ccf0b7c28ede`
2. Real wallet: `0x4291322a6b86e50f980feab6727b1497662d860f835dd7ecf4cc5184778156b8`
3. Crosschain plan: `0xa7a4e6534eae29e3befd495e9e58346faaa7fc9c2145af2e217982a898b27145`

The facilitator initially returned `status:pending` with each transaction hash.
The test did **not** treat that as final confirmation: it waited for Alchemy RPC
receipts, asserted `status:success`, decoded the token Transfer events, and compared
balances at the receipt block and preceding block. For every transaction:

- Buyer balance delta: `-20000` atomic units.
- Seller balance delta: `+20000` atomic units.
- Matching Transfer: buyer → seller, exactly `20000` atomic units.

Total service fees transferred: **0.06 USD₮0**. No swaps, bridges or Aave plan
steps were executed. These are real payment tests of the paid planning service,
not end-to-end execution tests of the generated financial plans.

## Reproduction

From `waypoint/backend`, with the existing private environment configured:

```sh
node --import tsx --test tests/asp-payment.test.ts
node --import tsx tests/asp-live.ts unpaid
# Explicit money movement: each command below costs 0.02 USD₮0.
node --import tsx tests/asp-live.ts paid default
node --import tsx tests/asp-live.ts paid wallet
node --import tsx tests/asp-live.ts paid crosschain
```

The live harness uses only Alchemy for RPC and never prints credentials or signed
payment headers. A future failure must be investigated before rerunning a paid
case to avoid duplicate charges. Do not import `src/server.ts` into the harness.

## Marketplace

The pre-update owned service was verified as Agent `14101`, numeric service
`41342`, UUID `a362c68d-789c-4577-a45e-286f950f755b`. No legacy serviceGuide was
present. The update changes only the four-line service description to match the
prepayment behavior; identity, service IDs, endpoint, price and recipient stay unchanged.

The description update succeeded with transaction
`0xd8119ac32a09dd9a9d919a351b90745bdfe32f43e6b22e6f9d54a3ef75f048e2`.

Resubmission returned at approximately 2026-10-04 05:30 UTC (13:30 Singapore):

```json
{
  "activate": { "approvalStatus": 5, "success": false },
  "submitApproval": [{ "approvalStatus": 2, "success": true }]
}
```

The activate portion echoed the old parameter-validation rejection; the new
submission succeeded. State: **submitted for review, not approved/published**.
No automatic retry or review polling was performed after this submission.

## Remaining boundaries

- The reviewer's exact rejected request is still unknown; passing these tests
  does not imply OKX has approved the listing.
- Prepared plans expire after 15 minutes and are process-local. Restart/expiry
  causes another preparation before payment verification.
- Model/RPC/facilitator outages remain possible. No invalid request should be
  replaced with a fabricated success or a different demo goal.
