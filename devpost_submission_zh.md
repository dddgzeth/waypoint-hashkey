# Devpost 提交内容中文对照版

> 跟 `devpost_submission.md`（英文，实际填表用）逐字段对照，方便你核对内容再决定要不要改英文版措辞。这份不用填进表单。

---

## General info

### Project name
```
Waypoint
```

### Elevator pitch（限 200 字符，已用英文写好，此处为中文含义）
一句话：Waypoint 是一个面向链上目标的 AI agent——说出你想要什么，它规划出跨链、跨协议的完整执行路径，校验计划，然后自动跑完全程。

---

## Project Story → About the project

按 Devpost 标准结构（Inspiration / What it does / How we built it / Challenges / Accomplishments / What we learned / What's next）翻译大意：

**Inspiration（灵感来源）**
现有的自然语言链上 agent（以 Bankr 为代表，真实上线、有交易量的产品）已经能处理官方预置的组合动作（swap、bridge、swap+send、cross-chain swap）。我们没有停留在猜测，而是亲自在 Bankr Terminal 上测试了一个具体场景（2026-08-12）："把 Base 上的 ETH 换成 USDC，桥到 Arbitrum，再存进 Aave 赚利息"——Bankr 自动完成了 swap+bridge（有真实链上交易记录），但到第三步明确停手，官方回复原话是"暂无一键存 Aave 的工具，你自己去 Aave 前端操作"。另外，Bankr 官方账号也公开承认过单轮对话的步数上限，让用户自己把复合请求拆成多轮消息。跨链结算这层基础设施本身已经很成熟（NEAR Intents 累计结算 $20B+，ERC-7683 被 Across/LI.FI/UniswapX 采纳）——缺的不是"怎么执行单个动作"，是"谁来规划跨越这些动作的完整依赖链"。

**What it does（做什么）**
Waypoint 是目标驱动而非命令驱动：不是一步一步下指令（先swap、再bridge、再deposit），而是用户一次性用大白话说出一个目标终态——"把资产集中变成 ETH，存进 Arbitrum 上收益最高的借贷协议"。Waypoint 读取用户在每条链上的真实资产，规划出从当前状态到目标状态所需的完整依赖图，执行前先展示计划给用户确认，然后自动执行全程——这里面正包括那个让现有 chat 类 agent 直接卡死、把任务丢回给用户的具体一步：跨链之后存入某个具体协议。

**How we built it（怎么做的）**
核心是五层 TypeScript pipeline，每一层都是对着真实基础设施跑的，不是 mock：
- 状态读取层——对钱包持有资产的每一条链做真实的链上批量读取（原生代币余额+该链的美元稳定币），保证规划永远从钱包的真实当前状态出发，而不是一份过期快照。
- 目标解析层——OpenAI structured output 把自由文本+用户当前钱包状态转成结构化目标，故意跟执行细节分开，这样 LLM 的幻觉不会直接碰到资金怎么动。
- 规划层——LLM 提议一份分步依赖图，需要时会先做一次实时链上收益率查询（直接读借贷协议的核心合约，不是缓存的利率）；确定性代码随后校验这份提议（链/协议白名单、空操作步骤检测、依赖步骤间链/代币连续性、动作类型一致性、金额字段格式是否合法），校验失败会带着具体错误原因重试，不会静默放行一个有问题的计划。
- 编排层（orchestrator）——真正的执行时状态机，也是我们最谨慎对待的一层：每一步在签名前都先做一次链上模拟，每一步的美元价值在模拟之前就先过一道硬性上限检查，各步骤严格按顺序执行，任何一步失败整个流程立刻停止而不是继续在不确定的状态上往下走，喂给依赖步骤的金额是上一步的*真实测量到账金额*——从它自己的交易回执里读出来，跨链步骤则通过跨链桥自己的到账状态接口确认——而不是计划里的估算值。底层接了两个跨链桥服务商和一个同链执行服务商，但都不是规划器绑死的固定依赖——上层的规划+校验才是真正的创新点。
- 计划确认——展示计划给用户看，不是一个二元的"是/否"闸门。用户的回复会按两个独立维度分类：这一轮在做什么动作（确认/修改/补充约束/表达风险顾虑/指出状态不对），以及针对计划的哪个部分（目标本身、某个余额、某一步、某个协议选择），再据此路由到对应处理（只重新规划某一步、把新约束并入目标重新规划、刷新过期的余额数据等），而不是给每种可能的表达都硬编码一个响应。

**Challenges we ran into（遇到的困难）**
- LLM 规划踩的坑不是那种一眼能想到的。反复运行后才发现：同链同代币的空操作"swap"、依赖步骤间链/代币接不上、真正跨链的操作被错标成同链——这些光看计划"感觉合理"发现不了，靠确定性校验+失败重试来拦。
- 真正开始执行后又冒出规划阶段测试根本发现不了的 bug：RPC 延迟导致一笔真实成功的转账被误报"到账 0"（改成直接读交易回执日志解决）；跨链到账其实是桥自己另外提交的交易，源链回执里看不到（改成轮询桥的状态接口解决）。规划器第一次真实生成的计划喂给编排层时，还直接暴露了一个金额字段格式的 bug——没动一分钱，但说明"schema 合法"和"真的能跑"是两条不同的标准。

**Accomplishments（值得骄傲的地方）**
竞品的缺口是亲自实测出来的，不是假设。整条 pipeline 已经端到端真实跑通：一句大白话目标，没有手写计划，真实目标解析→真实规划（带实时链上收益率查询）→真实执行，场景就是竞品做不到的那个——跨链桥接后存入具体借贷协议。每一步签名前都模拟、限定在很小的固定美元上限内、用真实到账（不是估算值）驱动下一步，全部在 Arbitrum/Base 主网用真实交易验证过。

**What we learned（学到的）**
真实测试胜过假设——竞品做不到什么、LLM 规划器哪里会错、生成的计划执行时会踩什么坑，都只有真跑起来才知道，不是纸上谈兵能想到的。

**What's next（下一步）**
现有协议之外接入更多协议、执行失败重试与恢复、条件触发型操作（如清算前自动减仓）。另外做一个 memory 层：跨会话记住用户操作习惯，正确理解和规划更长、更复合的目标。

---

## Built with
```
TypeScript, Node.js, OpenAI API, Zod, Express, viem, LI.FI, Relay.link, Enso Shortcuts, ERC-7683, Across, NEAR Intents, Aave
```

---

## "Try it out" links
- GitHub 仓库链接：https://github.com/dddgzeth/Waypoint
- Demo 视频链接：https://www.youtube.com/watch?v=J27PTVV5Pks

---

## Project Media（图片，建议准备）
- 演示视频里的一帧截图（比如依赖图机制那一帧）
- `plan.md` 第4节的架构图（导出成图片）
- `logo/final/waypoint-logo-lockup-large.png`
- `supporting-materials/waypoint-flow-demo.html` 的截图（一份静态单页流程展示，涵盖五层
  pipeline + Arbitrum/Base 主网真实交易证据——用浏览器打开后分段截图，或者直接把这个
  HTML 文件作为 Additional info 的附件上传）

---

## Additional info（给评委看，不公开）

- **Upload a File**：把 `waypoint-submission/` 文件夹（内容跟上面公开的 GitHub 仓库一致）打包成一个 zip 上传
- **Project name**：Waypoint
- **Track**：Web3 Applications, AI Agents and Real-World Use Cases
- **Team Type**：待定——确认是 Public Group 还是 Student Group（选 Student Group 的话每个成员都要附学生身份证明）
- **Team member list**：待定——格式"姓名（学校/公司/组织）"，多人用分号隔开
- **Primary Contact Email**：a903778821@gmail.com
- **Project description**（给评委看的内部技术描述，跟公开的 About the project 故事线不是同一份内容，这里更偏技术细节）：Waypoint 的规划层在设计上不绑定任何特定服务商：真实链上状态读取+OpenAI structured output 把自由文本转成结构化目标；LLM 提议一份分步依赖图，需要时先做一次实时链上收益率查询；确定性代码在任何一步被当作可执行之前先校验它（链/协议白名单、空操作步骤检测、依赖步骤间链/代币连续性、动作类型一致性、金额字段格式），校验失败进入带错误原因的重试循环。只有校验通过之后，某一步才会被路由给一个执行原语——这版 MVP 接了两个跨链桥服务商和一个同链多协议服务商，选它们是因为背后是成熟、经过审计的结算基础设施，不是规划器绑死的固定依赖。真正把这个项目跟"套壳 LLM 调用现成 intent 执行 API"区分开的，正是那个校验器，以及建在它之上的编排层：测试过程中校验器拦下了模型实际产出的具体 bug（同代币空操作"swap"、依赖步骤间链/代币接不上、真正跨链的操作被错标成同链、金额字段格式非法），而编排层的设计则是直接被真实执行才暴露出来的 bug 塑造出来的（RPC 延迟导致的到账测量假阴性、跨链到账根本不会出现在源链自己的回执里）。每一步在签名前都做模拟，且被限定在一个很小的固定美元上限内。这整条链路——一句自然语言目标进去，中间没有手写计划，真实链上执行出来——已经在 Arbitrum 和 Base 主网上用真实交易端到端跑通过，场景正是"Inspiration"部分记录的、主流竞品 Bankr 实测失败的那个：跨链桥接之后存入一个具体的借贷协议。我们在 2026-08-12 亲自实测了这个竞品，从它自己的回复确认了它正好卡在哪一步。
- **URL to open source and public code repository**：https://github.com/dddgzeth/Waypoint
- **URL to functional demo application**：没有上线的 demo app（这是一个后端 agent，不是网页应用）——demo 视频（https://www.youtube.com/watch?v=J27PTVV5Pks）和 Project Media / Additional info 里的 flow-demo 页面展示的是真实跑通的后端 pipeline（目标解析→规划→真实执行），包含 Arbitrum/Base 主网真实交易哈希
- **Uploaded file description**：项目仓库打包的 zip，内容：README.md（问题、方案、架构、验证结果）；backend/（完整 TypeScript 源码——状态读取、目标解析、规划器、编排层、供应商适配器，每笔验证过的主网交易哈希记录在 backend/README.md 里）；frontend/index.html（一个复现真实验证过的会话的静态 UI mockup）；demo-video/（跟 video 字段同一份演示视频）；supporting-materials/（架构图、流程证据页、截图）；logo/（品牌素材）。
