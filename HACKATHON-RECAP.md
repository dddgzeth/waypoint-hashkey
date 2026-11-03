# Waypoint 黑客松复盘 · 快速部署手册

> 已有 `../waypoint-project-overview.md`(2026-08-23 更新)是一份质量很高、诚实到近乎自曝短板的产品说明文档。
> 本文档不重复它讲过的内容,只做两件事:**(1) 对照 `backend/src/` 代码验证/补充实现细节;(2) 记录代码级别的坑**。
> 两份文档配合看:overview 讲"为什么这么设计",本文档讲"具体在哪个文件、怎么实现、哪里要小心"。

---

## ⚠️ 0. 安全警告(优先级最高,先看这条)

**`backend/secrets/privy_authorization_private.pem` 是一把真实的 EC 私钥文件**(`file` 命令确认
`PEM EC private key`),这是 Privy Authorization Key——根据 overview 文档,**这把 key 控制着所有托管执行钱包
(生成/导入路径)的签名授权**,泄露等同于所有托管资金可被任意转移。同目录下 `secrets/test-wallet-b.txt`(测试
钱包私钥/助记词)、根目录 `.env`(77 行,大概率含 Alchemy/Privy App Secret/CoinMarketCap 等真实 API Key)也是敏感材料。

这几份文件目前**就躺在项目源码目录里**,而这个项目目录已知至少被复制/打包过多次
(`waypoint.zip`、`universal_router/waypoint copy/`)。**在下次重新部署或分享这个仓库之前,应该:**
1. 确认这些 `secrets/*.pem`、`.env`、`*-tmp.mjs` 是否曾经被 `git add`/推送到过任何远程仓库(哪怕是私有仓库)。
2. 如果这个 Authorization Key 或任何 API Key 曾经离开过本机(上传、分享、打包发给别人),**当作已泄露处理,去 Privy /
   Alchemy / CoinMarketCap 后台轮换所有相关密钥**,而不是假设"反正是 hackathon 项目应该没事"——overview 文档自己
   都强调这条路径是真实资金、真实签名,不是模拟。
3. 下次新建类似项目时,`secrets/`、`.env` 应该从第一次 commit 起就在 `.gitignore` 里(检查了一下,当前 `.gitignore`
   确实排除了它们,这点做对了——但排除不了"文件已经在磁盘上被打包进 zip 分享"这种路径)。

---

## 1. 一句话定位

目标驱动的跨链执行 agent(NTU InnovateX 2026 Track 2 决赛项目)。七个职责单一的 agent 把自然语言目标
拆解成结构化计划,经过一套完全独立的第二模型复审,再用真实签名在真实链上执行——细节见 overview 文档,
这里补代码层面的验证。

---

## 2. 七个 agent 的真实文件映射(overview 文档没给出这张表)

| Overview 里的角色 | 实际文件 | 备注 |
|---|---|---|
| 1. Triage Agent | `src/agents/triageAgent.ts` | |
| 2. Readiness Agent | `src/agents/readinessAgent.ts` | |
| 3. Automation Intent Agent | `src/agents/automationIntentAgent.ts` | |
| 4. Intent Agent(goalParser) | `src/goalParser.ts` | **不在 `agents/` 目录下**,命名也不带 Agent 后缀——文件组织上的历史遗留,不影响功能但下次找代码容易找错地方 |
| 5. Planning Agent(planner) | `src/planner.ts` | 同上,不在 `agents/` 目录下 |
| 6/7. Review Panel(Goal-Match + Feasibility) | `src/agents/reviewAgent.ts` | **一个文件实现两个子 agent**,不是两个独立文件 |
| 整体串联 | `src/orchestrator.ts` | 真正的执行时状态机,不是"编排 LLM 调用"那种 orchestrator——它编排的是**签名+广播真实交易**这件事 |

`orchestrator.ts` 开头的大段注释本身就是一份很好的"设计决策记录",值得直接读(不只是看这份 recap 的转述):
- **故意不设平台级美元上限**——注释原话:"a hardcoded limit is a decision for whoever owns the funds, not for
  this codebase to impose on their behalf"。如果要加限额,应该做成用户自己设置的 per-account 配置,不是写死在代码里。
- **一个真实修过的 bug**:早期版本用"执行前后查余额差值"来判断一步操作实际到账多少,在一次真实成功的 swap 上
  读到了"收到 0"的假阳性——原因是"之后"那次余额查询打到了一个还没同步到最新状态的公共 RPC 节点。修复方案是
  **直接从这笔交易自己的回执(receipt)里解析 ERC20 Transfer 日志**,不依赖任何其他节点的状态——这是一个通用
  的"用交易自己的权威数据,不要用旁路查询去猜"的模式,值得记住。
- 跨链步骤的到账确认,同链读自己交易的 receipt,跨链则轮询桥(LI.FI `/status` 或 Relay `/intents/status/v3`)
  自己的状态接口,confirmed 到账后再去**目标链**那笔交易的 receipt 里读真实 Transfer 日志——不是猜测目标链余额差值。

---

## 3. 记忆系统:独立实现,不是跟 Synapse 共享代码

`src/memory/store.ts` 头部注释原话:"Modeled on Tencent/TencentDB-Agent-Memory's Chat Memory asset design"——
**这是概念上参考同一个上游框架(跟 Synapse-main 参考的是同一个 TencentDB Agent Memory),但代码是 Waypoint
自己独立重写的,不是从 Synapse-main 直接复制或共享模块**。规模也小得多(只有 3 个文件:`extraction.ts` /
`recall.ts` / `store.ts`,对比 Synapse `lib/memory/` 十几个文件 + 整个 `lib/tencentdb/`)。

Schema 上的简化(相对 Synapse):
- `l1_atoms`——只有 `type` + `content` + `scenario` 三个核心字段,**没有** Synapse 那套 8 类型
  (claim/method/observation/...)+ priority 打分体系。
- `l2_scenarios`——`summary` 是一个纯字符串字段,**不是**像 Synapse L2 那样由 LLM agentic 读写 Markdown 文件。
- `l3_persona`——同样是纯字符串 `summary` 字段,不是 agentic 文件编辑生成的 `persona.md`。
- L1 FTS 索引复用了跟 Synapse 一样的 **trigram tokenizer**(`tokenize='trigram'`)——这个选择(为了让中文
  不分词也能被索引到)是两个项目独立各自做出的同一个正确决定,不是抄的同一份配置。

**执行知识库**(`src/knowledge/store.ts` + `seed.ts`)只有 2 个文件,是一个更小的、独立的 FTS5 语料库,跟
`src/memory/` 是两套物理上分开但同构(都用 SQLite FTS5)的存储。

---

## 4. `custom_call` 硬约束怎么实现的(overview 第四节提到的"escape hatch")

`src/customCall/execute.ts` 的 `encodeCustomCall()`:用 viem 的 `parseAbiItem()` 解析人类可读的函数签名字符串
(比如 `"transfer(address,uint256)"`),再用 `encodeFunctionData()` 编码成真实 calldata。`coerceValue()` 递归处理
嵌套 tuple/tuple 数组类型的参数强制转换(JSON 反序列化后的值要按 ABI 类型逐个字段转成 `BigInt`/`bool`/原样字符串)。
文件头注释说明这套编码逻辑"verified against a real ERC20 approve() call"(拿真实 `approve()` 调用核对过 4 字节
selector 和参数编码是否正确)才接入生产路径——这是"新写的链上编码逻辑先拿一个已知正确答案的真实调用去对拍"的
验证模式,值得复用到任何"手写 ABI 编码"的场景。`src/customCall/allowlist.ts`(未细读,从文件名判断)应该是
overview 提到的"没用过的 (合约,函数) 组合首次必须用户确认"这条规则的白名单存储实现。

---

## 5. 一处手工维护的链配置(`src/chains/robinhood.ts`)

Robinhood Chain(Arbitrum Orbit L2)不在 viem 内置链列表里,代码手动 `defineChain()` 补了一份(chain id 4663,
RPC 地址来自官方文档)。**注释里明确记录了一个"没有就是没有,不要猜"的纪律**:代码没有给 Robinhood Chain 配
`aavePool` 地址,注释写"verified (2026-08) Aave V3 has no deployment on Robinhood Chain yet. Leave unset rather
than guessing"——下游的 `findBestAaveYield`/健康因子监控逻辑因为这个字段留空而自动把这条链排除在 Aave 候选之外。
**这是一个很小但很能体现代码风格的细节**:宁可留空触发下游正确的排除逻辑,也不猜一个可能是错的地址——跟
overview 里"事实优先于规则"那条设计原则是一致的,只是这次体现在一行配置上而不是一整套架构决策上。

---

## 6. 部署

`deploy/` 目录里是真实的生产部署配置(不是占位符):
- `deploy/waypoint.service` —— systemd service 单元文件
- `deploy/nginx-waypoint.cjlin.com.conf` —— nginx 反代配置,域名 `waypoint.cjlin.com`
  (跟 Synapse-main demo 视频用的 `synapse.cjlin.com` 是同一个域名下的不同子域,说明这两个黑客松项目部署在同一台/同一组服务器上)

部署前必须准备好的外部账号/密钥(从 `.env` 的变量名和代码里用到的 adapter 反推,具体取值不在本文档展开,
去 `.env.example`——如果没有就照着 `.env` 的 key 名单独整理一份——核对):
- Privy(App ID + App Secret + 本文档开头提到的 Authorization Key pem 文件)
- Alchemy(RPC + 代币元数据 API)
- CoinMarketCap(实时价格)
- Enso / OKX DEX(同链 swap 路由,一主一备)
- LI.FI / Relay(跨链桥聚合,均可选但至少配一个)
- 两套独立的 AI 模型/网关凭证(主 pipeline 一套,复审面板一套,故意用不同提供方)

---

## 7. 已知坑清单

| 症状 | 根因 | 修复/备注 |
|---|---|---|
| 私钥/密钥材料在项目源码目录里 | `secrets/*.pem`、`.env`、`test-wallet-b.txt` 没有被隔离到仓库外部 | 见第 0 节,下次部署前先确认有没有泄露 |
| "一步操作实际到账多少"曾经算错 | 用余额前后差值判断,撞上公共 RPC 节点状态滞后 | 改成直接解析该笔交易 receipt 里的 Transfer 日志(`orchestrator.ts` 注释里记录了完整故事) |
| `backend/` 根目录堆了 81 个 `*-tmp.mjs` 调试脚本 | 开发过程中的一次性验证脚本(check-balance-tmp.mjs、fund-execution-wallets-tmp.mjs 等)没有清理 | 不影响功能,但下次找"真正的源码入口"时容易被这些文件干扰视线,正式代码都在 `src/` 下 |
| Intent/Planning 两个 agent 在 `agents/` 目录里找不到 | `goalParser.ts`、`planner.ts` 历史上没有被归类进 `src/agents/` | 纯粹的文件组织不一致,读代码时留意 |

---

## 8. 目录结构速查表

```
backend/src/
  agents/
    triageAgent.ts          Agent 1
    readinessAgent.ts        Agent 2
    automationIntentAgent.ts  Agent 3
    reviewAgent.ts           Agent 6+7(Goal-Match + Feasibility 两个子 agent 在一个文件里)
  goalParser.ts              Agent 4(Intent),不在 agents/ 目录下
  planner.ts                 Agent 5(Planning),不在 agents/ 目录下
  orchestrator.ts             真正的执行时状态机(签名+广播真实交易),内含大量设计决策注释,值得通读

  adapters/                  真实第三方集成:aave健康因子/收益、alchemy、enso、lifi、okxDex、priceUsd、relay
  chains/                    5 条链配置(arbitrum/base/ethereum/polygon/robinhood),index.ts 是统一入口
  customCall/                escape-hatch 动作类型:allowlist.ts(白名单)+ execute.ts(ABI 编码)
  delegation/                EIP-7702 + MetaMask Delegation Framework(non-custodial 路径)
  triggers/                  DCA/健康因子自动化:completion.ts, dcaBuy.ts, monitor.ts, repay.ts, store.ts
  memory/                    独立实现的 L0-L3(比 Synapse 简化很多),见第 3 节
  knowledge/                 执行知识库(seed.ts + store.ts),独立于 memory/ 的另一套 FTS5 存储
  wallets/                   Privy 托管钱包(privy.ts)+ 钱包元数据存储(store.ts)
  accounts/                  账号/SIWE 登录(auth.ts, siweMessage.ts)+ 数据库连接(store.ts,memory 和
                              knowledge 都通过这里拿 db 实例,是真正的唯一 DB 入口)
  tokenReference.ts / tokenRegistry.ts / protocolTokenResolver.ts   代币符号/地址/精度解析
  stateReader.ts              读真实链上余额/状态
  server.ts                   HTTP 入口
  chat.ts                     对话循环入口(串联七 agent 的地方,配合 orchestrator.ts 一起读)

deploy/                      systemd + nginx 生产部署配置(域名 waypoint.cjlin.com)
secrets/                     ⚠️ 真实私钥材料,见第 0 节
*.mjs(backend 根目录)       81 个开发期临时调试脚本,不是正式代码

devpost_submission*.md, plan-finals*.md, youtube_submission.md   提交材料,跟 waypoint-project-overview.md 内容大体一致
```
