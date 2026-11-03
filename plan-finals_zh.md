# Waypoint —— 决赛计划中文版（NTU InnovateX 2026）

> 进决赛了：**8/21-23 现场**。演示+评审是 **8/23 周日 2:30-4:30 PM**——下面这些东西要在这之前就跑稳，不是卡着点才做完。
> 这是在 `plan.md`（Stage 1）基础上的第二阶段计划。`plan.md` 保持原样不动，作为提交截止时那版方案和验证记录的历史存档。

## 时间预算

- **8/21 周五 下午/晚上** —— Open Development
- **8/22 周六 全天** —— Open Development
- **8/23 周日 上午** —— Final Development（下午 2:30 就要开始演示了——留够彩排时间再收手，不要卡到最后一刻还在写代码）

## 优先级顺序

先做 1、2、3，大致按这个顺序，但 3 要打磨得最细，因为这是差异化故事里最有说服力的一个。4、5 是可靠性/加分项，放最后做，时间不够就先砍这两个。

1. 前端真的接上真实后端
2. Memory 层（基于 TencentDB Agent Memory / Synapse 改造）
3. 条件触发执行——"自主 agent"场景
4. 可靠性加固（失败重试、校验缺口、Morpho 适配器）
5. 自动选跨链桥服务商（LI.FI vs Relay）

---

## 1. 前端真的接上真实后端

### 现状

`frontend/index.html`（部署在 `waypoint.cjlin.com`）目前是纯静态 mockup：用 `setTimeout` 编排动画,回放一次真实录制好的会话数据,没有任何 `fetch()` 调用,没接真后端。`server.ts` 的 `/plan` 接口本身是真的（调用 `getWalletState` → `parseGoal` → `buildPlan`），但没有任何浏览器端代码去调它，而且压根没有 `/execute` 接口——这是 Stage 1 阶段刻意跳过的范围决定。

现场评审的话，一个照剧本回放的前端是个隐患：只要评委问一句"能不能换个目标试试"，马上就穿帮了。这部分必须变成真的。

### 设计

- **接 `/plan`**：把 mockup 里那套假的时间轴换成真实的 `fetch('/plan', { method: 'POST', body: JSON.stringify({ goalText, walletAddress }) })` 调用。真实接口返回什么就展示什么——真实解析出的目标、真实计划、计划校验失败时的真实报错（这个应该展示出来，不是藏起来——校验失败被抓住又自动重试，这是一个值得展示的**特性**，不是需要遮掩的 bug）。
- **CORS**：`server.ts` 需要加 `cors` 中间件，限定前端的 origin（如果前端和 API 走同一个域名/代理路径，直接放开 `*` 更简单，这里大概率就该这么做）。
- **`/execute` 接口——已拍板：方案 (b) 部署上线、硬性限额**。`/execute` 部署在 VPS 上、挂在真实的 `waypoint.cjlin.com` 域名后面，限定在现有的 `MAX_STEP_USD` 之内（现在是 $2，演示安全起见大概率还要再调低）。执行钱包要按**"水龙头"而不是"金库"**的思路来管理——默认它会被网上乱点的人玩到没钱，提前规划好补充节奏（演示前充一次，演示过程中还要留一个补充的缓冲），不是充一次就不管了。
- **部署**：`backend/`（Express server）得真的跑在 VPS 上——现在只有静态前端部署了。新建一个 systemd service（照抄已经跑通的 `waypoint.service` 那套模式），nginx 反向代理，真实 API key 只存在服务器的 `.env` 里，永远不会传到浏览器。
- **响应式，不做原生 app**：考虑过做原生手机 app，最后决定不做——这个时间窗口里既做不完也来不及让评委用上，而且会跟下面几个更有价值的项目抢时间。改成把现有网页前端做成响应式（手机浏览器打开也能正常用）——还是同一个页面，不新开一个构建目标，成本主要是在已有页面上做 CSS 布局适配。
- **账号体系，新增的必做项**：因为 `/execute` 现在是真实、公开、共享的了，而且 memory（第 2 部分）需要一个稳定的身份才能挂靠，所以这个 app 需要真实账号体系，不能再是匿名共享 session。`app.html` 变成两个 tab：
  - **Login**——真实的、经过认证的 session，绑定一个账号，跨访问持久保留 memory（第 2 部分），能用真实执行。
  - **Try App**——不需要登录。默认方案（需要你确认，见"待定问题"）：真实调用 `/plan`（真实目标解析+规划，真实钱包读取），但没有持久 memory，也不能碰 `/execute`——这样访客立刻就能拿到真实的规划体验，执行和 memory 是登录的理由，而不是把整个东西锁起来变成一个演示壳子。

### 信任模型：执行权到底怎么授权（这部分是真的来回讨论过才定下来的，把推理过程也记下来，跟结论一样重要）

之前一直把三件事混在一起，需要拆开：**(a)** 账号登录（谁在跟这个 app 对话）、**(b)** 钱包绑定（这个账号名下有哪些地址）、**(c)** 交易签名权（谁真的有权授权一笔交易）。Synapse 的账号实现（`lib/memory/store.ts`：`users` 表、scrypt 密码哈希、OAuth）对 (a) 是个不错的参考，但完全没碰 (b)/(c)——Synapse 不需要动用户的钱，Waypoint 需要，这部分不能靠假设，得真去查。

- **(a) 登录**：SIWE（用钱包签一条挑战消息来建立 session）。不需要密码，跟"钱包就是身份"这个前提一致。
- **(b) 多钱包绑定**：一个账号可以挂多个地址。绑第一个之后再加一个，是再签一条消息——不是登录，是一条明确的"把地址 X 绑定到账号 Y"的消息，在已登录状态下签的，后端验证签名，全程不碰私钥。以后用绑定过的**任意**一个地址登录都会落到同一个账号上。这是标准做法（OpenSea/Zerion 那种"加钱包"），不是什么新发明。
- **(c) 执行权——这个是真正需要花时间调研的地方。** 最直接的想法（"连上钱包，每笔交易实时签"）在两个地方站不住：钱包多了要来回手动切换，体验很差；而且对第 3 部分的条件触发**根本不可行**——触发的时候用户不在场，没人能点"签名"，这恰恰是那个场景存在的意义。真去查了三个方案，不是拍脑袋：
  - **Safe + Zodiac Roles Modifier**（成熟、经过审计，DAO 金库委托操作的标准做法）——**排除**：它的权限只对**已经在 Safe 合约里的资产**生效，普通 EOA 不行。用户得部署一个 Safe，还要把资产真的转过去——而且 Waypoint 是多链的，每条链都要单独部署 Safe、单独转一次。有真实 gas 成本，还有"我的钱现在在一个新地址里"这个心理门槛，跟 Waypoint"读你已有的多链资产"这个卖点本身就拧巴。
  - **MetaMask Agent Wallet / Embedded Wallets**（TEE 加密密钥托管，自带 Blockaid 模拟+威胁扫描，消费上限——理论上是最贴合的）——**这个时间窗口里排除**：目前还锁在 Early Access 申请制后面，没有公开的自助 API/SDK 文档，而且公开文档里没说清楚它到底是绑定用户**已有**的、有真实资金的地址，还是新建一个托管钱包。值得黑客松之后等它正式开放、文档更全了再回头看，但不能把决赛的进度压在一个审批周期未知的申请上。
  - **EIP-7702 委托，通过 MetaMask 开源的 Delegation Framework——这是我们要做的方案，取代了下面的 ZeroDev 方案。** EIP-7702（2025 年 5 月 Pectra 硬分叉就在以太坊主网生效了）能让用户**已有**的 EOA 直接获得智能账户能力，**不需要搬家**：不用部署新合约，不用转移资产，地址不变。
    - **ZeroDev 是最初的方案，已经放弃。** 它的 bundler/paymaster 基础设施要用任何主网链都必须开付费 dashboard 项目（$69/月起的 "Launch" 计划）——免费版只能用测试网。这是真实测过的结论（拿我们自己的 project id 真实调用了 ZeroDev v3 的 RPC，base/arbitrum/polygon/robinhood 全部被拒绝，同一个 project 换成测试网链 id 立刻能用），不是猜测。
    - **`@metamask/smart-accounts-kit`**（MetaMask Delegation Framework 的开源 SDK，MIT-0/Apache-2.0 协议，npm 公开可装，不用注册申请）完全免费替代了它，今天就能在真实主网上用。它的 `DelegationManager.redeemDelegations()` 是一个普通的外部函数（ERC-7710）——任何 relayer 都能直接用一笔普通交易调用它，所以**完全不需要 bundler 也不需要 paymaster**：Waypoint 现有的、已经出资的 executor 钱包直接付 gas 就行，跟 orchestrator 现在发的其他交易一样。
    - Caveat enforcer（MetaMask 对 session key 权限策略的叫法）能对应上跟 ZeroDev 一样的安全约束：`AllowedTargets`/`AllowedMethods`（限定能调用哪些合约的哪些函数）、`ValueLte`（消费上限——对应 `MAX_STEP_USD`）、`Timestamp`（有效期）、`LimitedCalls`（限流），另外还有几个 ZeroDev 没有的（`NativeTokenTransferAmount`、ERC-20/721/1155 余额变化类 caveat、流式/周期转账类 caveat）。
    - **在 Base 主网上真实端到端验证过了，不是只看文档。** 两笔真实的、小额真实 ETH 的验证交易：（1）一个临时 EOA 签了一次 7702 authorization + 一个 `NativeTokenTransferAmount` 范围限定的 delegation；relayer 在一笔交易里同时完成了激活+执行，正好转移了限额规定的那么多，重放攻击也正确地在链上被拒绝了（`NativeTokenTransferAmountEnforcer:allowance-exceeded`）。（2）同一套机制去执行一笔**真实的 LI.FI 报价 swap**（任意目标合约+任意 calldata，不只是简单转账），用的是 `FunctionCall` 范围的 delegation——这一步中途踩了一个真实的坑：看起来更"自然"的 `NativeTokenTransferAmount` 范围其实会默默强制要求 calldata 为空（它就是为纯转账设计的），拿去跑 swap 直接 revert（`ExactCalldataEnforcer:invalid-calldata`），换成 `FunctionCall` 范围、selector 从真实报价里现取，才跑通。余额用锁定区块号的方式核对的（redeem 交易刚上链后立刻查余额，命中了一个滞后的公共 RPC 节点，看起来像什么都没发生——跟 `orchestrator.ts` 里已经记录过、也已经绕开的那类问题是同一个坑）。
    - **还有一个没解决的产品问题，需要你来定，不是继续查资料能解决的：** 浏览器插件钱包（包括 MetaMask 本身）目前都没有任何 RPC 方法能让网页拿到原始的 EIP-7702 authorization 签名（`viem` 自己的 `signAuthorization` 明确只支持本地账户；钱包侧压根还没这个方法——`viem` 自己 GitHub 上的 discussion 也确认了这个缺口）。Delegation 本身的签名（EIP-712 caveat 结构）倒是没问题，任何浏览器钱包用标准的 `eth_signTypedData_v4` 就能签——只有一次性的 7702 authorization 这一步被卡住。也就是说，一个真实用户连上自己的 MetaMask，今天没法直接通过我们的网页完成激活这一步。Try App / 真实用户流程要怎么处理这个问题需要你来定——选项包括：Try App 体验用一个后端持有私钥的演示钱包（不影响真实用户资产）、等钱包侧支持这个功能上线、或者别的办法。这里刻意先不猜答案。
  - 这套机制也顺带解决了多钱包执行的体验问题：每个绑定的钱包各自做**一次性**授权，授权完之后，不需要实时连接钱包插件、不需要手动切换，后端就能在授权范围内直接对任意一个执行。

### 工作量

大——从"接线活"变成了"接线活 + 一套真实账号体系 + 一套真实的委托执行层（EIP-7702 + MetaMask Delegation Framework）"。orchestrator/planner/部署那套模式在"构造交易"这一层还是原样复用；真正新增的是"谁有权签这笔交易"，这是真正的新基础设施，不是改个配置就完事。委托机制本身（`src/delegation/delegation.ts`、`src/delegation/store.ts`）截至目前已经在主网上真实端到端跑通验证过了；剩下的是把它接进 orchestrator 的多步骤计划执行和 `/execute` 端点（卡在上面那个开放的产品问题上），而不是继续验证委托机制本身。

---

## 2. Memory 层

### 对上一版的纠正

上一版这部分有两个地方是错的，现在都改过来了：

1. **参考对象搞错了。** 上一版直接引用 Synapse 自己 README 里"跟上游相比只改了两处"这句话，好像 Synapse 就能代表 [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) 了。直接拉了一遍真实的上游仓库（不是靠 Synapse 转述），差距比这大得多：上游是一整套多服务的 **Memory Hub** 平台——`MemoryCore` + `MemoryHub` + `Proxy` 是三个独立部署的服务，四种不同的资产类型（Chat Memory、Skill、Wiki、CodeGraph），还有团队/角色/ACL 权限体系、多 agent 的"装备"绑定机制。这套东西是给一个团队里多个 agent 共享经验用的，不是给单个黑客松 agent 用的。正确的做法是：直接去看上游 **Chat Memory** 这一种资产类型的设计（这才是跟 Waypoint 真正相关的部分），照着这个设计自己搭一套轻量版存储——而不是继承 Synapse 对它的简化描述。
2. **多轮对话这个判断错了。** Waypoint 就是要做成一个多轮聊天应用，这是必须的，不是可选项。用户不可能每次都一句话就把需求说清楚，agent 得能追问、能继续对话。这个也直接影响第 1 部分（前端）：`app.html` 需要一个真正的对话循环，不是一次性的"目标进、计划出"表单。
3. **L2/L3 这个判断也错了。** 应该保留，不该砍。L2/L3 记住的是这个具体用户*怎么操作*——偏激进还是偏保守，信任哪些协议，遇到风险怎么反应——这些信息能让 agent 在生成计划和给建议的时候更贴合这个用户的风格，而不只是记住孤立的事实。这是一个真实的、轻量版的"钱包/用户画像"，不是可以砍掉的边角料。

### 参考：上游 Chat Memory 的真实设计（直接读
[Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory) 自己的
README，不是转述）

| 层级 | 存的是什么 | 主要用途 |
|---|---|---|
| **L0 Conversation** | 带完整上下文的原始对话 | 核对原话、时间戳、出处 |
| **L1 Atom** | 从对话里提取出的事实、偏好、约束、事件 | 精确召回可执行的信息 |
| **L2 Scenario** | 按项目/场景组织起来的知识块 | 快速恢复一个工作上下文 |
| **L3 Core/Persona** | 长期画像、稳定的行为模式、高层认知 | 让 agent 快速进入某个用户的语境 |

检索是分层的，不是拍平的：**L2/L3 是每轮都默认注入的快速上下文启动包**；**L1/L0 是兜底**，只有在真的需要某个具体事实的时候才通过 BM25 + 向量检索 + RRF 去查，而且每次结果都受条数、字符预算、超时时间三重限制，防止 memory 把真正的上下文窗口挤占掉。（上游给这套设计引用的 benchmark：PersonaMem，开启 memory 后从 48% 提升到 76%，测的是 agent 在长时间交互后能不能正确理解并运用用户信息。）

### Synapse 现在真正的作用是什么

不再是 memory 设计的参考对象——而是证明了一套**真正的多轮 agent 对话循环**能在 Node/TypeScript 上搭得很好：`lib/memory/chat-loop.ts`、`useChat` hook + `DefaultChatTransport` 流式输出这套模式、`lib/memory/store.ts` 里 `l0_conversations` 表做的会话/消息持久化、还有 `scheduler.notifyTurn` 这个触发模式（轮次计数+互斥锁，没有空闲计时器）用来在不阻塞聊天回复的情况下跑后台提取。这正是 Waypoint 的 `app.html` 从"一次性表单"变成"真实聊天界面"之后需要的那套工程实现，而且已经验证过能跑通——复用的是这套*实现机制*，不是它的 memory 数据结构。

### Waypoint 这边怎么落地

自己搭一套轻量版 SQLite 存储（不是把上游那几个服务直接部署起来——那是真要搭的基础设施，为了这个时间窗口里的单个 agent 犯不上），用钱包地址/账号身份（见第 1 部分）做 key，照着上面 L0→L3 这套分层：

- **Waypoint 的 L1 Atom 类型**（事实/约束/偏好，这是上游 L1 自己的定义）：`gas_reserve`、`protocol_preference`、`chain_preference`、`risk_tolerance`、`recurring_goal`、`execution_outcome`。
- **L2 Scenario**：按用户活动里反复出现的主题分块（比如"在 Arbitrum/Base 之间集中收益"、"监控一个 Aave 杠杆仓位"）——把跟这个主题相关的 L1 atom 聚合起来，对应上游"恢复一个工作上下文"这个用途。
- **L3 Persona**：一份简短的、持续更新的画像——风险偏好、链/协议使用习惯、长期约束——不管匹不匹配都**每一轮**都注入，跟上游"默认注入的快速上下文启动包"一样。这是让 agent 能调整计划*风格*的那一层（比如给一个画像标着保守的用户建议更稳妥的路径），不只是召回孤立事实。
- **提取触发时机**：每完成一轮对话/一个目标周期后触发（对应上游"对话结束后跑异步 pipeline"的模型，触发机制借鉴 Synapse 的轮次计数+互斥锁），一次 LLM 调用，每个 L1 atom 类型都是严格类型化 JSON 输出。
- **Recall**：L3 persona + 相关的 L2 scenario 默认每轮注入；L1/L0 兜底搜索（先用 FTS 起步——BM25/向量/RRF 是上游的完整版，时间够的话再上）只有在当前这轮真的需要某个具体记住的事实时才触发，条数/字符预算/超时都按上游说的限制。

### 工作量

大——现在是真正意义上的两个新子系统，不是一个：memory 存储本身（这次是照着上游正确建模的 L0-L3），以及 `app.html`/`server.ts` 里 memory 层要挂靠的真实多轮聊天循环。Synapse 的对话循环代码对第二部分来说是个实打实的加速器。

---

## 3. 条件触发执行——自主 agent 场景

这就是最初 `plan.md`（§5）里的"场景二"，当时明确标注为"路线图展示，黑客松期间不实现"。现在把它捡回来——这是差异化故事里最有说服力的一个：**唯一能证明这个 agent 会自己监控、自己反应，而不是"用户问一次、agent 跑一次"的场景。**

### 为什么这个重要（怎么讲这个故事）

那些做杠杆/循环贷仓位的大资金用户，或者持仓在一些没有好用原生工具的小众/非主流 DeFi 协议里的用户，恰恰是最容易面临清算风险、也最缺工具监控的一群人。实时监控健康因子 + 自动减仓，对这群受众来说是一个具体、有实际价值的能力——不是一个泛泛而谈的"AI agent"演示噱头。

### 设计

几乎完全复用现有 pipeline——新增的部分很小：

1. **触发器 schema**——给 `Goal`（`models.ts`）加一个可选的触发结构：
   ```
   trigger: {
     metric: "aave_health_factor",
     chain: string,
     operator: "<" | ">",
     threshold: number,
     targetValue?: number,   // 如果适用，要恢复到的目标健康因子
   } | null
   ```
   `goalParser.ts` 需要能识别条件式表达（"如果我在 Arbitrum 上的健康因子跌破 1.3，就还款直到恢复到 1.8 以上"），把它填进这个结构，而不是当成一个立即执行的一次性目标处理。

2. **新适配器 `adapters/aaveHealthFactor.ts`**——读 Aave V3 核心 `Pool` 合约的 `getUserAccountData(user)`，这个函数的返回值里直接包含 `healthFactor`。一个很小的单次 view 调用——延续 `aaveYield.ts`（`getReserveData`）已经用过的那套"用核心合约、对着真实部署的 ABI 验证过，不是照文档假设"的纪律。

3. **监控循环，新建 `monitor.ts`**——一个简单的轮询器：对每个已注册的触发器，按间隔读取当前健康因子（通过上面那个新适配器），跟阈值比较。一旦触发：
   - 在*触发那一刻*用真实的当前链上状态合成一个新目标（"把健康因子从 `currentHF` 恢复到链上 `chain` 的 `targetHF`"）——**不是**在注册时就预先算好一份计划，因为等触发真正发生的时候，抵押物/欠款金额早就变了。这样可以完全不改地复用 `buildPlan` 和 `runPlan`。
   - 触发时不需要用户实时确认——用户在注册这个触发器的时候就已经预先授权过了（对应 `plan.md` §4.2 护栏层那句"触发式场景可预先设置好确认策略"）。orchestrator 原有的模拟先行、硬性美元上限、失败即停这些安全机制原样适用，不用改。

4. **注册入口**：最简单可行的版本是一个 CLI 脚本，或者一个 `/trigger` POST 接口，存下触发条件（钱包、条件、目标），启动/确认 monitor 正在盯着它。演示不需要一个完整的 UI 表单才有说服力——monitor 真的触发并真实执行，这才是重点，不是那个注册用的表单长什么样。

### 触发的时候操作谁的仓位——现在第 1 部分有了真实的委托执行方案，这里也要更新

之前几版这部分都假设触发演示只能用**我们自己的**演示仓位，因为当时没有一个验证过的、能让 monitor 在用户不在场时操作用户自己资金的办法。现在第 1 部分已经有了——EIP-7702 委托，通过 MetaMask Delegation Framework——所以演示的目标可以是**一个真实登录用户自己的仓位**，用跟第 1 部分同一套一次性委托授权流程，不是另外搞一套机制，**前提是第 1 部分里那个还没解决的浏览器钱包问题先解决**。演示仓位还是保留，但作为兜底方案，不是主计划：如果到真要定下来演示脚本的时候那个问题还没解决/接完，就退回用我们自己的演示仓位（跟项目里其他地方已经用过的托管模式一样，不引入新风险），不要在台上用没验证过的委托机制去操作真实资金演示。

### 演示怎么可靠触发，以及怎么诚实地解决这个问题

在两小时的评审窗口里，指望现场真的让一个仓位触及清算阈值是不现实的——我们控制不了市场价格，而且专门为了彩排去搭一个保证金很薄的真实借贷仓位，每次演练都要真金白银地搭进去抵押物和 gas。

**提出的方案——不伪造健康因子本身，只是现场选阈值这个参数**：现场注册触发器时，把阈值设在这个仓位*真实当前健康因子之上*（比如仓位真实健康因子是 3.0，就设"HF < 5.0 时预警/减仓"）。monitor 读到的是**真实**链上健康因子，触发的条件也是**真实成立**的——只是因为我们现场选了一个比较激进的阈值,所以立刻就触发了,这本身也是合理的（一个谨慎的大资金用户完全可能真的设一个这么保守的预警阈值）。健康因子的读取和减仓的执行都没有任何模拟或伪造成分——只有"选哪个阈值"这一个参数是为了演示节奏挑的，如果评委当场问起来，这也是一个诚实、能解释清楚的选择。

**链的选择——纠正**：上一版把这个问题框成"演示用 Arbitrum 还是 Base"。这个框架本身就错了——优先级应该是确保**Waypoint 现在已经声称支持的每一条链**（`base`、`arbitrum`、`polygon`、`robinhood`——见 `tokenRegistry.ts`）都真的稳定可靠，而不是挑一条"保底不出问题"的链去做触发演示，剩下的链没怎么测就晾在那。只声称支持这么几条链，结果*这几条*里面还有 bug，比不支持更多链要难看得多——这是第 4 部分的可靠性工作，不是第 3 部分的演示脚本选择题，而且要全面做，不能只做触发演示最后用到的那一条链。

### 工作量

中等。复用现有基础设施的比例大概 90%（goal parser、planner、orchestrator，以及读 Aave 核心合约那套模式）。新增的东西确实很小：一个 schema 扩展、一个小适配器、一个轮询循环、一个注册入口。

---

## 4. 可靠性加固（放最后做，在 5 之前）

- **验证每一条已经声称支持的链都真的能用**，不只是现场演示恰好用到的那一条——`base`、`arbitrum`、`polygon`、`robinhood`（见上面第 3 部分的纠正）。把 Stage 1 那套真实交易测试矩阵（`backend/README.md` 的"Verified"部分）在这四条链上都重新跑一遍，不能只测已经跑过的 Arbitrum/Base 那几对组合。
- `orchestrator.ts` 里的失败重试/部分失败恢复（目前设计上是任何一步失败就整个流程停止——这是故意的，但现场演示的话，至少对 RPC 超时这种瞬时性失败做一个有边界的重试会更稳，逻辑性错误不重试）。
- 补上 `backend/README.md` 已知限制里写的 `"output_of(step1) + output_of(step2)"` 组合表达式校验缺口——现在连续性检查器会静默跳过它。
- Morpho 适配器，让"最优收益协议"变成至少两个协议之间的真实比较，不是默认只有 Aave 一个选项。

## 5. 自动选跨链桥服务商（时间紧张的话优先砍这个）

Planner 现在永远只会生成 `vendorAdapter: "lifi"`，要用 Relay 得手动指定。加一个比价逻辑（成本/速度），让 planner 或 orchestrator 自动选——是加分项，不是核心演示故事的必需品。

---

## 已拍板（原本待定，现在定了）

1. ~~`/execute` 要不要公开~~ ——**部署上线，硬性限额，水龙头式资金管理**（第 1 部分）。
2. ~~Memory 的 persona/L3 层~~ ——**保留**，不砍；重新定位成一个真实的钱包/用户画像，用来影响计划的风格，不只是召回事实（第 2 部分）。
3. ~~触发演示用哪条链/哪个协议~~ ——**不是单选一条链的问题**；改成把现有四条链全部加固（第 3、4 部分）。
4. ~~登录机制~~ ——**登录/绑定钱包用 SIWE，执行权用 EIP-7702 委托（通过 MetaMask Delegation Framework，不是 ZeroDev——见第 1 部分）。** 这是真去调研了委托执行方案（Safe+Zodiac、MetaMask Agent Wallet、ZeroDev+ERC-4337、MetaMask Delegation Framework）之后定的，不是拍脑袋——完整推理和其他方案为什么被排除，见第 1 部分"信任模型"那一节。这个方案顺带也解决了多钱包执行的体验问题（每个钱包一次性授权，不用实时切换），并且让第 3 部分的触发场景有了真的能操作用户自己仓位的路径，不用只局限于演示仓位——**前提是第 1 部分里那个还没解决的浏览器钱包问题先解决**。

## 还待定的问题（开工前或开工过程中需要拍板）

1. **"Try App"（不登录）能做到什么程度**（§1）：故意先不定——先把核心功能（账号、memory、委托执行、触发器）做出来，等真的有东西了，再看免登录版本要展示这里面的哪一部分。
2. **真实用户自己的浏览器钱包怎么完成 7702 激活这一步**（§1，新增）：已经确认，目前没有任何浏览器插件钱包（包括 MetaMask）给网页提供能拿到原始 EIP-7702 authorization 签名的 RPC 方法——今天只有本地（后端持有私钥）的账户能签这个。委托机制本身已经做完并且验证过了；这个问题具体是指一个真实连了 MetaMask 的用户在我们网页上会看到什么。需要你来拍板，不是继续查资料能解决的。

## 已验证（原本"需要验证"，现在用真实代码和真实主网交易确认过了）

**MetaMask Delegation Framework**（§1）——不是 ZeroDev（见第 1 部分为什么放弃：主网必须开付费计划）。`@metamask/smart-accounts-kit` 是开源的、npm 公开可装、不用注册。对照了包里真实安装的源码（`node_modules/@metamask/smart-accounts-kit`）和 MetaMask 官方文档（docs.metamask.io/smart-accounts-kit），然后在 Base 主网上用两笔真实交易验证过（`backend/test-delegation-e2e-tmp.mjs`、`backend/test-delegation-swap-tmp.mjs`、`backend/src/delegation/delegation.ts`）：

```typescript
// 一次性 EIP-7702 authorization（目前只有本地/后端持有私钥的账户能签——
// 真实浏览器钱包用户会看到什么，见上面"还待定的问题"）
const authorization = await delegatorWallet.signAuthorization({
  account: delegatorAccount,
  contractAddress: environment.implementations.EIP7702StatelessDeleGatorImpl,
});

// 范围限定的 delegation。FunctionCall（不是 NativeTokenTransferAmount）才是
// 用来限定任意合约调用的范围——NativeTokenTransferAmount 会默默强制要求 calldata
// 为空，拿去跑真实 swap 会 revert（ExactCalldataEnforcer:invalid-calldata，
// 这是测出来的，从类型定义看不出来）。
const delegatorSmartAccount = await toMetaMaskSmartAccount({
  client: publicClient,
  implementation: Implementation.Stateless7702,
  address: delegatorAccount.address,
  signer: { walletClient: delegatorWallet },
});
const delegation = createDelegation({
  to: relayerAddress,
  from: delegatorSmartAccount.address,
  environment: delegatorSmartAccount.environment,
  scope: { type: ScopeType.FunctionCall, targets, selectors, valueLte: { maxValue: capWei } },
  caveats: [{ type: "timestamp", afterThreshold: 0, beforeThreshold: expiresAt }],
});
const signature = await delegatorSmartAccount.signDelegation({ delegation });

// relayer 直接 redeem——DelegationManager.redeemDelegations 是一个普通的外部函数
// （ERC-7710），不涉及 bundler/paymaster/EntryPoint。如果链上还没激活，
// 在同一笔交易上带 authorizationList 就能同时完成激活+执行。
const redeemCalldata = DelegationManager.encode.redeemDelegations({
  delegations: [[signedDelegation]],
  modes: [ExecutionMode.SingleDefault],
  executions: [[createExecution({ target, value, callData: data })]],
});
await relayerWallet.sendTransaction({
  to: environment.DelegationManager,
  data: redeemCalldata,
  authorizationList: needsActivation ? [authorization] : undefined,
});
```

真实验证交易（Base 主网）：一笔限额转账的 delegation，正好转移了限额规定的那么多，重放攻击也正确地被拒绝了（`NativeTokenTransferAmountEnforcer:allowance-exceeded`）；一笔真实的 LI.FI 报价 swap（SushiSwap Aggregator 路由）完全通过一个 `FunctionCall` 范围的 delegation 执行，用锁定区块号的余额读取核对过（0.00015 ETH 换进去，0.28593 USDC 换出来，跟报价基本一致）。两笔交易里，签授权的账户都没花一分钱 gas——全是 relayer 付的。
