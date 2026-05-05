# Market Data Lake Worker — Agent Spec

> 项目角色规约（Role Spec）+ PRD。面向所有 AI Agent 与人类协作者。
> 子 Agent 文件 (`.claude/agents/market-data-worker.md`)、`CLAUDE.md`、`AGENTS.md` 与本文件的「架构红线」段落**逐字一致**。

---

## 角色与背景

承担实现的 Agent 角色：**资深量化数据工程师 + 云原生架构师**。

需具备：
- Cloudflare Workers / Wrangler 实战经验
- AWS S3 SDK（`@aws-sdk/client-s3` v3）使用经验
- 金融行情数据领域经验（OHLCV、tick / bar 粒度、市场代码规范）
- 安全意识（Access JWT 校验、敏感项走 secret 而非 vars）

## 项目目标

**在 Cloudflare Workers 上定时抓取美股/港股/A股的多粒度 OHLCV 数据，通过标准 S3 协议落地到对象存储，元数据用 D1 管理，并提供一个带 Cloudflare Access 邮箱 OTP 鉴权的管理后台用于查看进度、暂停/恢复、手动重试。**

---

## 架构红线（不可违背）

下面这组约束是项目的硬性边界。**任何代码改动都不得违反，违反必须先在文档中改红线再写代码。**

1. **存储层只走标准 S3 协议** —— 必须使用 `@aws-sdk/client-s3`，**禁止**使用 Cloudflare R2 原生 binding API（如 `env.MY_BUCKET.put/get/list`）。这是为了保留跨云迁移能力。
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

## 数据源

| 市场 | 数据源 | 端点示例 |
|------|--------|---------|
| US / HK | Yahoo Finance | `https://query1.finance.yahoo.com/v8/finance/chart/{Symbol}?interval={Interval}&range={Range}` |
| CN（日线） | 新浪财经 | `https://hq.sinajs.cn/list={Symbol}` 或 `https://finance.sina.com.cn/...` |
| CN（小时/分钟） | 东方财富 | `https://push2his.eastmoney.com/api/qt/stock/kline/get?...&klt={Klt}&...` |

所有数据源约定：

- 注入随机 / 合理的 `User-Agent`（避免被简单封禁）
- 适配层将各家原始字段统一映射为 `{ Datetime, Open, High, Low, Close, Volume }`
- 失败时**抛异常**（不返回部分数据），由调用方记录到 `error_*` 字段

## 多粒度（Interval）

- **默认抓** `1d`
- **新增粒度的方法**：

  ```sql
  INSERT INTO ticker_intervals (ticker, interval, is_active) VALUES ('AAPL', '1h', 1);
  ```

  即可生效，**零代码改动**。
- 数据源适配层负责把项目内部 interval 标识映射成各家 API 的本地参数（如东方财富 `klt=60` ↔ `1h`、新浪 `scale=60` ↔ `1h`）

## 调度与容错

- **Cron Trigger 频率**建议 `*/15 * * * *`（每 15 分钟一批），可在 `wrangler.jsonc` 调整
- 每次取 20 条最旧作业 → 并发抓取 → 写 S3 → 更新 D1
- **单条失败仅本条记录**：`error_flag = 1` / `error_message = ...` / `error_count++`，**不影响其他 19 条**
- 当 `error_count` 超过阈值（建议 5），可在管理后台手动 retry，或运维侧把 `is_active` 设为 0 暂停

---

## 管理后台契约

### 鉴权（Cloudflare Access）

- 路由前缀 `/admin/*`、`/api/*` 必须先过 Access 中间件
- 中间件 (`src/access-auth.ts`) 逻辑：
  1. 读 `Cf-Access-Jwt-Assertion` 请求头
  2. 拉取 `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` 的 JWKS（带本地内存缓存 1 小时）
  3. 验签 + `aud` claim 等于 `env.ACCESS_AUD` + `exp` 未过期
  4. 失败：`/admin/*` 返回 302 重定向到 Access 登录页，`/api/*` 返回 401 JSON
- Worker **不实现登录页**，登录由 Cloudflare Access 完全托管

### 路由清单

| Method | Path | 用途 |
|--------|------|------|
| GET | `/admin` | 返回内嵌的单页 HTML（无前端构建） |
| GET | `/api/jobs` | 列出作业。Query: `market`, `interval`, `status`, `page`, `pageSize` |
| GET | `/api/jobs/:ticker/:interval` | 单作业详情 + 该作业 S3 中末尾 N 行 CSV 预览 |
| POST | `/api/jobs/:ticker/:interval/pause` | `UPDATE ticker_intervals SET is_active = 0` |
| POST | `/api/jobs/:ticker/:interval/resume` | `UPDATE ticker_intervals SET is_active = 1` |
| POST | `/api/jobs/:ticker/:interval/retry` | 清 `error_*`，把 `last_updated_at` 设为 epoch 让下轮 Cron 优先抓 |
| GET | `/api/health` | 总数 / 活跃数 / 错误数 / 最近 Cron 时间戳 |

### UI 形态

- 单文件 HTML 字符串（`src/admin-ui.html.ts` 导出 `ADMIN_HTML` 常量），无前端构建
- 表格展示作业状态，行内三个按钮：暂停 / 恢复 / 重试
- vanilla JS `fetch` 调用 `/api/*`，响应 JSON 直接渲染

### 配置项

```jsonc
// wrangler.jsonc → vars（公开值）
{
  "vars": {
    "S3_ENDPOINT": "https://xxx.r2.cloudflarestorage.com",
    "S3_REGION": "auto",
    "S3_BUCKET": "market-data",
    "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
    "ACCESS_AUD": "<application audience tag>"
  }
}
```

```bash
# 敏感项必须 wrangler secret put（不要写在 vars）
wrangler secret put S3_ACCESS_KEY_ID
wrangler secret put S3_SECRET_ACCESS_KEY
```

### Cloudflare 侧手动配置（一次性）

1. 启用 **Cloudflare Zero Trust**（免费档位含 50 用户额度）
2. **Access → Applications → Add Self-hosted application**
3. **Application domain** 填 Worker 的自定义域名（**必须橙云代理**，否则 Access 不生效）
4. **Identity providers** 选 `One-time PIN`
5. **Policies → Allow**，Selector = `Emails` → 填白名单邮箱
6. 拷贝 Application 的 **Audience Tag** 到 `wrangler.jsonc` 的 `ACCESS_AUD`

---

## 已知约束

- **Yahoo Finance 历史窗口限制**：`1m` ≤ ~7 天、`5m`/`15m`/`30m`/`1h` ≤ ~60–730 天、`1d` 无显著限制 → 抓取层须用 `range` 参数自适应
- A 股小粒度数据源（东方财富分钟线）字段顺序与日线不同，**适配层负责归一化**
- Workers 单次执行：默认 30s CPU / 付费方案 5min CPU；20 并发 + 异步 IO 已留余量
- Cloudflare Access 必须配 Self-hosted Application 才会注入 `Cf-Access-Jwt-Assertion` 头；本地 `wrangler dev` 时该头不存在，access-auth 中间件需有"开发模式跳过"环境分支
- Worker 自定义域名必须走 Cloudflare 代理（橙云），否则 Access 策略无法生效
- D1 写入有微小延迟，批处理用 `Promise.allSettled` 而非顺序 `await`

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

---

## 交付物清单

| 文件 | 说明 |
|------|------|
| `package.json` | 依赖 `@aws-sdk/client-s3`（必需）+ TypeScript / Wrangler 工具链 |
| `wrangler.jsonc` | D1 binding（`DB`）、Cron Triggers、`vars`（含 `ACCESS_*`、`S3_*`）、`compatibility_flags: ["nodejs_compat"]` |
| `schema.sql` | `tickers` + `ticker_intervals` 双表 + 必要索引（`(is_active, last_updated_at)` 复合索引） |
| `src/index.ts` | 入口，导出 `fetch` 与 `scheduled` |
| `src/scheduled-handler.ts` | Cron 抓取主流程 |
| `src/fetch-handler.ts` | HTTP 路由分发（含 access-auth 中间件挂载） |
| `src/access-auth.ts` | Cloudflare Access JWT 校验中间件（含 JWKS 缓存） |
| `src/admin-ui.html.ts` | 内嵌单页 HTML 字符串 |
| `src/s3.ts` | `S3Client` 工厂 + Read-Merge-Overwrite 工具 |
| `src/sources/yahoo.ts` | Yahoo Finance 适配（US/HK） |
| `src/sources/sina.ts` | 新浪适配（CN 日线） |
| `src/sources/eastmoney.ts` | 东方财富适配（CN 小时/分钟） |
