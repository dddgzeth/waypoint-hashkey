# Waypoint — 决赛计划 v2（NTU InnovateX 2026）

> 决赛演示/评审时间：**8月23日周日 2:30–4:30 PM**——写这份文档时是8月21日，还剩2天。
> 这是在 `plan-finals.md`（第二阶段，本身建立在 `plan.md`/第一阶段之上）基础上的第三阶段计划。
> 之前那两份保持不动，是已完成、真实测试过的历史记录。这份文档是在真实研究了一遍
> Cobo Agentic Wallet（https://github.com/CoboGlobal/cobo-agentic-wallet）之后写的下一层——
> 既是为了在评审时提升技术深度，也是因为这些想法本身确实是好的。

## 这份文档从哪来

两条线汇合成了这个计划：

1. **读了 Cobo Agentic Wallet 公开的 agent skill 文件**（他们仓库里的
   `skills/cobo-agentic-wallet/SKILL.md`），发现了一个真实的、生产级的五段式流水线——
   `Parse Intent → Query Recipe → Design Execution Plan → Define Policy/Completion
   Conditions → Assemble & Verify`——跟 Waypoint 现有的 goalParser → planner 结构上很接近，
   但在两点上更进一步，值得借鉴：按需检索知识而不是塞一整块静态 prompt，以及在结果交给
   用户之前有一个显式的自洽性检查阶段。
2. **Demo 本身的宣讲角度**："Context is All You Need"（呼应"Attention is All You
   Need"）——核心论点是 Waypoint 真正的优势不是换一个更大的模型，而是在每个决策点上
   喂给模型什么样的真实上下文。记忆模块（已经做好了）是一个例子。一个精心构建的链上
   执行知识库是下一个。

**用户直接明确表态、对下面所有内容都有约束力的设计立场**：优化**灵活性**，不是限制。
Cobo 的"Pact"本质上是一个权限/约束对象（基础设施强制的预算、白名单、过期时间）——那是
他们的深度轴，Waypoint 不打算在那条轴上跟他们拼（没有 MPC 基础设施，没有机构级托管的
背书，拼这个会输）。Waypoint 的深度轴是**在真实的、实时的、多步骤、跨链条件下的推理能力**——
一个只能在一个很窄的预先批准范围内操作的 agent，对这次 demo 想展示的东西来说，用户体验
更差，不是更安全。下面每一条想法的取舍标准都是"这个能不能让 agent 理解/执行得更好"，
而不是"这个能不能多加一层限制"。

---

## 1. 执行知识库（"Context is All You Need"，第二部分）

### 不是什么

不是 Cobo 的 Recipe-as-模版（`pact_template`——一份带 `{{placeholder}}` 字段、需要 agent
去填的预先结构化 JSON）。模版规定的是**结构**。这跟我们想要的正好相反——planner.ts 已经
通过 `ExecutionPlan`/`PlanStep` 这个 schema 自己生成结构了，再往每个协议的模版上锁一层，
是跟上面"灵活性"这条立场对着干的。

### 是什么

一个小型的**事实性语料库**，用来提升链上执行推理的准确性/速度，按需检索出来，作为
上下文喂给模型——从来不是代码强制执行的规则。用不用、怎么用，还是模型自己判断。这跟
这次会话里 targetAmountUsd 那个修复背后的哲学是一样的：一个想用正则硬编码"什么才算美元
金额"的兜底最后被删掉了，因为它不可能穷举所有语言/黑话/记法；真正对的做法是给更好的上下文
（一个实时价格事实）+ 相信模型自己读懂这句话的能力。知识库就是把这个模式推广开：以后每次
发现一个边界情况，不是再写一条代码层面的正则匹配，而是写成知识库里的一条事实——可检查、
加一条记录就能扩展，不会再制造"兜底代码覆盖了本来正确的 LLM 判断"这类 bug（这次会话已经
踩过两次）。

### 1.1 执行类知识——种子内容来自这次会话真实踩过的坑，不是凭空想的

下面每一条都是 Waypoint 自己今天真实踩到并修复过的问题。对 demo 来说是很强的真实性
故事（"这个知识库不是假设出来的，每一条事实背后都对应一个我们真实修过的 bug"）：

- Polygon（以及 L2 普遍）的 gas price 可能在几秒内暴涨——原生代币全额转账要用实时的
  EIP-1559 费率估算并留出较大（约3倍）缓冲，不能用一个过时的 `gasPrice` 快照。
  （今天真实踩过：一笔 Polygon 真实转账报错 "gas required exceeds allowance"。）
- 原生代币余额为0的钱包，连转 ERC20 都付不起 gas——需要先从一个有钱的钱包垫一点原生
  代币过去，而且这笔垫付的确认在下一次 RPC 读取时不一定能立刻读到（要轮询，不能假设
  负载均衡的 RPC 提供商能"写后立读"一致）。
- Aave V3 的 aToken 精度永远跟底层资产完全一致——这次会话早些时候有个真实 bug 把它
  写死成了6（USDC 的精度），结果 WETH 存款的数值被静默地报错了。
- 跨链到账是桥自己的 relayer/solver 另开的一笔交易——永远不要靠比较目标链余额差值去猜
  （会跟其他无关活动撞车）；要轮询桥自己的状态接口（LI.FI 的 `/status`，Relay 的
  `/intents/status/v3`）直到它报告已送达，再从那笔交易自己的 Transfer log 里读真实到账
  数量。
- 跨语言的加密圈货币口语简写（中文"U"/"刀"指 USDT/美元等）——这应该是一条模型能直接用
  的事实，而不是想用正则去穷举每一种记法（试过，删掉了，见 chat.ts/goalParser.ts 的
  改动历史）。
- 美元计价的金额必须用真实的实时价格换算，绝不能靠训练数据里的记忆估算——这次会话早些
  时候真实踩过：模型猜了一个过时的 ETH 价格，把"$4"换算成了实际只值一半左右的金额。
- 垃圾币/钓鱼币识别的启发式规则（URL 特征、诱导性措辞）——已经在 `stateReader.ts` 里
  写成真实过滤逻辑了；也值得同时写成知识库里的一条事实，这样如果用户问起来，模型能
  解释"为什么这个代币被过滤了"，而不是默默丢掉。

以后新增事实按同样的方式来：测试中踩到真实 bug → 写成知识库条目，不是代码层面的模式
匹配，除非它是一个硬性的数学/身份约束（参考这次会话里已经明确定下来"该留在代码里"的
那几条：gas 预留的数学计算、transferFrom 跟实际签名者的身份匹配、无意义 swap 的拒绝——
这些是正确性上的硬约束，不是语言理解层面的判断题，应该继续留在确定性代码里）。

### 1.2 外部数据源知识目录——新增，这是这次讨论里扩展出来的部分

上面 1.1 是"链上执行细节"层面的知识。这一类是更上层的：**agent 应该默认知道主流链上
数据源/聚合平台各自能提供什么、适合回答什么类型的问题**，而不是每次都要真的去上网搜。
这是知识库里一个独立的子类别，条目形式是"某网站：提供什么数据、适合回答什么问题、
（如果有公开API）大致怎么接入"。

**已经确认了解、且值得优先写进去的：**

- **DefiLlama**（defillama.com）：DeFi 领域最标准的 TVL 聚合器，横跨几乎所有公链和协议。
  除 TVL 外还有 Yields（各协议各资金池的实时 APY 排行）、Stablecoins（稳定币供应/脱锚
  监控）、DEX 交易量、协议 Fees/Revenue、跨链桥流量、融资轮次追踪（Raises）。有免费
  公开 API（api.llama.fi），结构清晰、免鉴权、社区广泛在用。
- **RootData**（rootdata.com）：加密项目/投融资数据库，收录项目背景、融资轮次、投资方、
  团队信息、生态归类——回答"这个项目是谁做的、融了多少钱、属于哪个生态"这类问题。

**同类别、置信度稍低（写进种子内容前需要真实核实细节，但"这个工具是干嘛的"这个认知
本身是有的）：**

- **DeBank**（debank.com）：多链钱包持仓聚合，一个地址在所有协议里的头寸都能一次看到。
- **Dune Analytics**（dune.com）：链上数据可 SQL 查询的分析平台，社区维护海量自定义
  dashboard，几乎任何指标都能找到人做过的查询。
- **L2Beat**（l2beat.com）：以太坊 L2 的安全性/去中心化程度分级（Stage 0/1/2）+ TVL
  追踪，判断"这条 L2 到底有多信任最小化"的标准参考。
- **Token Terminal**（tokenterminal.com）：协议财务基本面（收入、费用），比单纯 TVL
  更偏"这个协议到底真实赚不赚钱"。
- **Nansen / Arkham Intelligence**：地址标签与资金流向情报（"聪明钱"追踪、地址归属
  真实身份），偏机构/安全分析场景。
- **CoinGecko / CoinMarketCap**：价格和市值数据（CMC 我们已经在用，`priceUsd.ts`）。
- **DeFiSafety / Immunefi**：协议安全评分、bug bounty 覆盖状态，判断"这个协议审计过
  没有、安不安全"。
- 各链区块浏览器（Etherscan/Basescan/Arbiscan/Polygonscan）——已经在程序里真实用着
  （`ETHERSCAN_API_KEY`）。

**值得做成真实接入、不只是静态知识的一项**：DefiLlama 的 Yields API 免费、公开、结构
简单，值得这个周末真的接进来——能把现在 `needsYieldLookup` 只查 Aave、只覆盖5条链的
实时收益率比较，直接扩展成横跨全 DeFi 协议的真实比较，这个提升对 demo 来说分量很大，
而且是在已经做好的功能上直接加深，不是从零起。

### 实现方式——复用现有 memory 的 FTS5 基础设施，不重新造一套

Waypoint 已经有完全符合这个需求的检索机制，在 `memory/store.ts`/`memory/recall.ts`
里：`l1_atoms`（内容）+ `l1_fts`（一个 FTS5 虚拟表，`tokenize='trigram'`，跟 `l1_atoms`
内容关联）+ `searchL1Atoms()`（FTS MATCH 查询）+ `buildMemoryContext()`（把检索到的
内容拼成可以直接放进 prompt 的字符串）。这整套是按账号隔离的（每个用户自己的记忆）。
知识库是同一套模式，加一个**不分账号**的第二语料库：

- 新表 `execution_knowledge(id, title, keywords, body, created_at)` + 一个平行的
  FTS5 虚拟表 `execution_knowledge_fts`，同样用 trigram 分词。
- `searchExecutionKnowledge(query: string, limit = 3): KnowledgeEntry[]`——FTS
  MATCH 查询，不带 `account_id` 过滤（这个语料库不是按用户分的）。
- `buildKnowledgeContext(query: string): string`——跟 `buildMemoryContext` 同样的
  形状，把检索到的条目包成类似 `<execution-knowledge>...</execution-knowledge>` 的
  格式。
- 查询词的构造：参考 Cobo `caw recipe search --keywords` 的做法，从 `Goal` 对象里
  提取 chain/token/protocol/action-type 当关键词（`targetChain`、`targetAsset`、
  `action`），而不是拿整段自然语言去搜。
- 接入 `planner.ts` 的 `buildPlan()`，跟 `yieldNote`/`priceNote` 现在的接法一样：
  多加一条 note 拼进同一个 prompt，比如叫 `knowledgeNote`。也可以考虑在
  `goalParser.ts` 里接一个更轻量的版本，给意图解析阶段就用得上的事实（比如货币口语
  那条，应该在这一步就能用上，不只是在 planner 里）。
- 种子脚本：写一个一次性的 `seed-knowledge.ts`（或者内联在一次迁移里），把上面
  1.1 和 1.2 的条目真实插入进去——先写死一版，暂时不需要运行时可编辑。

### 为什么值得在周日之前投入时间做

这个能直接现场演示：给一个带真实黑话货币金额、或者带低 gas 钱包场景的目标，边跑边讲
"模型这里用的不是训练数据里的猜测,也不是写死的规则——它是从我们自己真实踩过的坑
建出来的知识库里,现查现用了一条真实事实,用的还是跟记忆系统同一套检索基础设施"。这是
一个具体的、可验证的"context is all you need"演示环节,不只是 PPT 上一句话。

---

## 2. 流水线升级——Assemble & Verify 阶段（"多 agent 复审"的落地方式）

Cobo 自己的 skill 文件里有第五个阶段"Assemble Pact"，职责明确就是在提交之前检查
intent、plan、policy、completion conditions 这几样东西是否互相自洽——不自洽就打回重做。
这是一个真实的、已经上线的先例，对应了聊天里之前提到的"多 agent 复审"：不是笼统地
"再加一个 agent"，而是一个具体、狭窄的职责——**生成出来的 plan 是否真的对应解析出来
的 goal**——作为独立于生成 plan 那次调用之外的另一次 LLM 调用。

### 设计

- planner.ts 里新增一个函数（或者新建一个 `verifier.ts`），`verifyPlan(goal, plan,
  wallets): Promise<{ ok: true } | { ok: false; reason: string }>`。
- 在 `buildPlan()` 自己那次 LLM 调用 + `validatePlan()` 的确定性检查都通过之后运行，
  在 plan 返回给用户之前。
- 它唯一的职责：把 goal 和 plan 放在一起读，判断这个 plan 是不是真的完成了 goal 描述
  的事情——资产对不对、链对不对、钱包对不对、金额量级对不对、有没有漏步骤、有没有多余
  步骤。要是真正独立的第二次阅读，不是同一次调用回头批改自己的作业（喂给它 goal 和
  完成的 plan 本身，不喂生成过程中的对话历史）。
- 如果 `ok: false`，把原因喂回 `buildPlan()` 已有的重试循环（跟 `validatePlan()` 用
  的同一套 `MAX_PLAN_ATTEMPTS` 机制）——多一个"这里具体错在哪，改"的信号来源，不是
  静默拒绝。
- 可演示的场景：故意构造一个能被这个阶段抓出来的真实不匹配（比如就在写这份 v2 计划之前，
  planner 曾经对一个解析不出来的钱包昵称静默生成了一个 `steps: []` 的空计划——如果有
  一个 verify 阶段，应该能把这个明确标记成"这个 plan 没有完成声明的转账目标，没有生成
  任何步骤"这样一个显式的、讲得清楚的失败，而不是让一个静默的空计划直接到达用户面前）。

---

## 3. Completion Conditions——从触发器里抽象出来，通用化

Cobo 的 schema：`{ type: "tx_count" | "usd_spent" | "token_amount_spent" |
"time_elapsed", threshold: ... }`。Waypoint 现在的 DCA 和 health-factor 触发器各自
写死了自己的一套停止逻辑。优先级低于上面 1、2，但改动小、干净：

- 在 models.ts 里加一个共享的 `CompletionCondition` 类型（上面 Cobo 那四种变体）。
- 把 DCA 触发器"买几次/持续多久"的逻辑重构成用这个共享结构，而不是自己一套专属字段。
- 除非1、2都做完了明显还有富余时间，否则周日之前不急——这是代码质量/通用性上的提升，
  不是本身就能拿出来演示的新能力。

---

## 4. 结构化校验反馈——小改动

`validatePlan()` 已经会把纯文本的失败原因喂回模型自纠正（跟 Cobo 的 `.message` 是
同一个思路）。Cobo 还会返回一个 `.suggestions`。改动成本很低：`PlanValidationError`
抛出时，可以顺带附一条简短的 `suggestion` 字符串（比如对一个错误的 `transferTo`，
建议"去账号已知的钱包列表里解析这个标签"），塞进重试的 prompt 里。锦上添花，不是
核心——只有1、2都做完了还有余量才做。

---

## 按剩余约2天时间排的优先级

1. **执行知识库**（第1节）——这是 demo 宣讲的实际内容，第一优先级，做完一定要真实
   测试过，不能只是理论上通。
2. **Assemble & Verify 阶段**（第2节）——第二优先级，真实提升技术深度，而且有一个
   具体的"看，它真的抓出了一个不匹配"的演示时刻。
3. Completion Conditions（第3节）和结构化校验反馈（第4节）——只有1、2都做扎实了、
   还有富余时间才做。时间紧的话最先砍掉这两个。

这里的所有东西都按这次会话一直以来的方式真实测试：真实账号、真实链、真实会动钱的
交易，绝不走捷径。临近截止日期也不例外。
