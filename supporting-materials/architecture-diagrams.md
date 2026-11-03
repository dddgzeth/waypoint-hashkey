# Waypoint — Architecture Diagrams (plan.md §4)

> Paste each block into https://mermaid.live (or open this file in VS Code with the
> Mermaid preview extension, or view it on GitHub, which renders Mermaid natively) to
> get a clean rendered image to screenshot.

## 1. System Architecture (§4.2)

```mermaid
flowchart LR
    subgraph SRC["Goal Sources"]
        direction TB
        A1["User\nnatural-language input"]
        A2["On-chain\ncondition trigger"]
    end

    SRC --> B["State Aggregation\nParallel multi-chain\nbalance reads"]
    B --> C["Goal Parser (LLM)\nText + state ->\nstructured goal"]
    C --> D["Planner\nGoal -> dependency\nstep graph"]
    D --> E

    subgraph E["Execution Layer"]
        direction TB
        E1["Orchestrator\nRouting, state machine,\namount resolution, retries"]
        E2["Vendor Adapters\nLI.FI / Relay / Enso"]
        E1 --> E2
    end

    E --> F["Guardrail Layer\nPlan preview + simulation\n-> user confirmation"]
    F --> G["Execution Runner\nSign, confirm, read output,\nfeed into next step"]
```

## 2. Confirmation-Stage Classification Pipeline (§4.3)

```mermaid
flowchart LR
    U["User's reply"] --> R1{"Local rule\nfast-path"}
    R1 -->|"Match"| OUT1["(X, Y)\n0 LLM calls"]
    R1 -->|"No match"| R2["LLM classification\n-> x_action, y_target"]
    R2 --> R3{"Keyword\ncorrection gate"}
    R3 --> M["Routing matrix"]
    OUT1 --> M
    M --> RES["Sub-flow:\nre-plan / refresh /\nclarify / execute"]
```

## 3. Worked Example — Dependency Graph (§4.1)

Wallet: 0.5 ETH on Base, 200 USDC on Polygon, 0.1 ETH on Arbitrum.
Goal: *"Consolidate these assets into ETH and deposit into the best-yielding lending
protocol on Arbitrum."*

```mermaid
flowchart LR
    W1["Base: 0.5 ETH"] --> S3["Step 3<br/>Cross-chain swap<br/>Base ETH -> Arbitrum ETH"]
    W2["Polygon: 200 USDC"] --> S1["Step 1<br/>Same-chain swap<br/>Polygon USDC -> Polygon ETH"]
    S1 --> S2["Step 2<br/>Bridge<br/>Polygon ETH -> Arbitrum ETH"]
    W3["Arbitrum: 0.1 ETH (existing)"] --> S4
    S2 --> S4["Step 4<br/>Protocol deposit<br/>All Arbitrum ETH -> best-yield<br/>lending protocol on Arbitrum"]
    S3 --> S4
    S4 --> RESULT["Final state: consolidated ETH position,<br/>deposited into the highest-APY protocol on Arbitrum"]
```
