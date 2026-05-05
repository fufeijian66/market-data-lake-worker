# market-data-lake-worker

跑在 Cloudflare Workers 上、**S3-only**（禁用 R2 binding）、**多粒度**（日/小时/分钟可配置）、自带 **Cloudflare Access 鉴权管理后台**的全球股市行情爬虫。

完整 PRD 见 `agent-spec.md`。本文件是 Claude Code 项目记忆，重点放架构红线、目录结构、运维命令与编码规则。

---

## 架构红线（不可违背）

下面这组约束是项目的硬性边界。**任何代码改动都不得违反，违反必须先在文档中改红线再写代码。**

1. **存储层只走标准 S3 SigV4 协议** —— 使用 `aws4fetch` 做 SigV4 签名（约 5KB，零 Node 依赖，Workers 上稳定），**禁止**使用 Cloudflare R2 原生 binding API（如 `env.MY_BUCKET.put/get/list`）。这是为了保留跨云迁移能力。原计划用 `@aws-sdk/client-s3` 但该 SDK 在 Workers 即使开 `nodejs_compat` 仍因 `@smithy/*` 子依赖触发运行期异常，故已替换。
2. **凭证只从 env 读** —— `S3Client` 初始化必须从 `env.S3_ENDPOINT` / `env.S3_REGION` / `env.S3_ACCESS_KEY_ID` / `env.S3_SECRET_ACCESS_KEY` 读取，禁止在代码中硬编码任何 endpoint、region、access key。
3. **对象 Key 格式固定** —— `{Market}/{Interval}/{Ticker}.csv`，例如 `US/1d/AAPL.csv`、`US/1h/AAPL.csv`、`HK/1d/0700.HK.csv`、`CN/1d/sh600519.csv`。
4. **支持的 Interval 取值** —— `1m | 5m | 15m | 30m | 1h | 1d | 1wk | 1mo`（与 Yahoo Finance 命名对齐；A 股数据源做映射适配）。
5. **CSV 列固定** —— `Datetime, Open, High, Low, Close, Volume`。`Datetime` 一律使用 ISO 8601 UTC 字符串（如 `2026-05-05T00:00:00Z` 表示日线、`2026-05-05T14:00:00Z` 表示小时线），覆盖所有粒度。
6. **写入流程必须是 Read-Merge-Overwrite** —— `GetObjectCommand` → 解析 CSV → 合并新数据 → 按 `Datetime` 去重并升序排序 → `PutObjectCommand` 覆盖；`NoSuchKey` / 404 当作空数组处理，不视为错误。
7. **D1 schema 双表布局** ——
   - `tickers(ticker PK, market)`：标的主表，`market` 取值仅限 `US | HK | CN`。
   - `ticker_intervals(ticker, interval, is_active, last_updated_at, error_flag, error_message, error_count, PRIMARY KEY (ticker, interval), FOREIGN KEY (ticker) REFERENCES tickers(ticker))`：抓取作业表，每个 `(ticker, interval)` 组合一条记录。**`is_active` 在作业层**，使"暂停某 ticker 的小时线但保留日线"成为可能。
8. **批处理调度** —— 每次 Cron 触发，从 `ticker_intervals` 中筛 `is_active = 1` 的作业，按 `last_updated_at` 升序取最旧的 20 条；单条失败不阻断整批，只更新 `error_flag` / `error_message` 并 `error_count++`。
9. **管理后台与抓取流水共用同一个 Worker** —— fetch 路由前缀 `/admin/*`（HTML）和 `/api/*`（JSON）必须经过 Cloudflare Access JWT 校验（读取 `Cf-Access-Jwt-Assertion` 头并对照 Access team 域名的 JWKS 验签）；**禁止**在 Worker 代码或 D1 中存储任何用户名/密码。

---

## 目录结构

```
.
├── package.json
├── wrangler.jsonc           # Workers 配置（D1 binding、Cron、vars）
├── schema.sql               # tickers + ticker_intervals 双表
├── agent-spec.md            # 完整角色规约（PRD 风格，含部署步骤）
├── AGENTS.md                # 跨 Agent 通用记忆（与本文件共享红线）
├── CLAUDE.md                # 本文件
├── .claude/
│   └── agents/
│       └── market-data-worker.md  # Claude Code 专项子 Agent
└── src/
    ├── index.ts             # 入口，导出 fetch 与 scheduled
    ├── scheduled-handler.ts # Cron 抓取主流程（每次 20 条最旧作业）
    ├── fetch-handler.ts     # HTTP 路由分发（/admin、/api/*）
    ├── access-auth.ts       # Cloudflare Access JWT 校验中间件
    ├── admin-ui.ts          # 内嵌的单页 HTML 字符串
    ├── s3.ts                # S3Client 工厂 + Read-Merge-Overwrite
    └── sources/
        ├── yahoo.ts         # 美股/港股
        ├── sina.ts          # A 股日线
        └── eastmoney.ts     # A 股小时/分钟线
```

---

## 运行 / 部署命令

```bash
npm install
wrangler dev                                          # 本地调试
wrangler d1 execute market_data_lake --file=./schema.sql            # 初始化 D1
wrangler d1 execute market_data_lake --command "INSERT INTO ..."    # 加种子数据
wrangler secret put S3_ACCESS_KEY_ID                  # 敏感项进 secret
wrangler secret put S3_SECRET_ACCESS_KEY
wrangler deploy
```

---

## 常见陷阱

- `aws4fetch` 在 Workers 上零依赖运行；不需要 `nodejs_compat`，加了反而可能干扰 module 加载
- 阿里云 OSS 走 SigV4 时，`S3_REGION` 必须填 `cn-shanghai`（**去掉 `oss-` 前缀**），否则签名会被拒；`S3_ENDPOINT` 仍是完整的 `https://oss-cn-shanghai.aliyuncs.com`
- `Cf-Access-Jwt-Assertion` 头只有在 Cloudflare 侧建好 Self-hosted Application 后才会注入；本地 `wrangler dev` 时该头不存在，`access-auth.ts` 需有"开发模式跳过"的环境分支
- 部署前敏感项务必 `wrangler secret put`，**不要**写进 `wrangler.jsonc` 的 `vars`
- Worker 自定义域名必须走 Cloudflare 代理（橙云），否则 Access 策略无法生效
- D1 写入有微小延迟，批处理用 `await Promise.allSettled` 而非顺序 `await`

---

## Claude Code 专项 Agent

仓库内置一个子 Agent `market-data-worker`（位于 `.claude/agents/market-data-worker.md`）。在涉及"数据抓取 / S3 合并 / D1 调度 / Cron / 管理后台路由"的任务时会被自动调度。

如需手动调用：在对话里说 "use the market-data-worker subagent to ..."。

---

## 默认编码规则

### 1. 编码前思考

**不要假设。不要隐藏困惑。呈现权衡。**

LLM 经常默默选择一种解释然后执行。这个原则强制明确推理：

- **明确说明假设** — 如果不确定，询问而不是猜测
- **呈现多种解释** — 当存在歧义时，不要默默选择
- **适时提出异议** — 如果存在更简单的方法，说出来
- **困惑时停下来** — 指出不清楚的地方并要求澄清

### 2. 简洁优先

**用最少的代码解决问题。不要过度推测。**

对抗过度工程的倾向：

- 不要添加要求之外的功能
- 不要为一次性代码创建抽象
- 不要添加未要求的"灵活性"或"可配置性"
- 不要为不可能发生的场景做错误处理
- 如果 200 行代码可以写成 50 行，重写它

**检验标准：** 资深工程师会觉得这过于复杂吗？如果是，简化。

### 3. 精准修改

**只碰必须碰的。只清理自己造成的混乱。**

编辑现有代码时：

- 不要"改进"相邻的代码、注释或格式
- 不要重构没坏的东西
- 匹配现有风格，即使你更倾向于不同的写法
- 如果注意到无关的死代码，提一下 —— 不要删除它

当你的改动产生孤儿代码时：

- 删除因你的改动而变得无用的导入/变量/函数
- 不要删除预先存在的死代码，除非被要求

**检验标准：** 每一行修改都应该能直接追溯到用户的请求。

### 4. 目标驱动执行

**定义成功标准。循环验证直到达成。**

将指令式任务转化为可验证的目标：

| 不要这样做... | 转化为... |
|--------------|-----------------|
| "添加验证" | "为无效输入编写测试，然后让它们通过" |
| "修复 bug" | "编写重现 bug 的测试，然后让它通过" |
| "重构 X" | "确保重构前后测试都能通过" |

对于多步骤任务，说明一个简短的计划：

```
1. [步骤] → 验证: [检查]
2. [步骤] → 验证: [检查]
3. [步骤] → 验证: [检查]
```
