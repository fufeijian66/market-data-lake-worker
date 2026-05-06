// HTTP 路由分发：/admin（HTML） + /api/*（JSON）
// 任何路由进入业务逻辑前必先过 access-auth 中间件（架构红线 #9）

import type { Env, JobRow, Market, TickerJob, Interval } from './types';
import { requireAccess } from './access-auth';
import { createS3Client, objectKey, tailCsv } from './s3';
import { ADMIN_HTML } from './admin-ui';
import { runScheduled, fetchOneJob } from './scheduled-handler';
import { fetchListings } from './sources/listings';
import { EXPECTED_BARS } from './constants';

export async function handleFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/') {
    return guarded(req, env, () =>
      new Response(ADMIN_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
  }
  if (url.pathname.startsWith('/api/')) {
    return guarded(req, env, () => handleApi(req, env, ctx, url));
  }
  return new Response('Not Found', { status: 404 });
}

/** 套上 Access 中间件 + 顶层异常捕获 */
async function guarded(
  req: Request,
  env: Env,
  handler: () => Promise<Response> | Response,
): Promise<Response> {
  try {
    await requireAccess(req, env);
  } catch (resp) {
    if (resp instanceof Response) return resp;
    return new Response('Internal Error', { status: 500 });
  }
  try {
    return await handler();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonErr(msg, 500);
  }
}

async function handleApi(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (method === 'GET' && path === '/api/health') return apiHealth(env);
  if (method === 'GET' && path === '/api/jobs') return apiJobsList(env, url);

  // —— 系统级控制 ——
  if (method === 'GET' && path === '/api/system') return apiSystemGet(env);
  if (method === 'POST' && path === '/api/system/cron/toggle') return apiSystemCronToggle(env);
  if (method === 'GET' && path === '/api/system/diag') return apiSystemDiag(env);
  if (method === 'POST' && path === '/api/system/run') return apiSystemRun(env, ctx);
  if (method === 'POST' && path === '/api/system/run-sync') return apiSystemRunSync(env);
  if (method === 'POST' && path === '/api/system/import') return apiSystemImport(env, url);
  if (method === 'POST' && path === '/api/system/fetch-bulk') return apiFetchBulk(env, ctx, req);

  // /api/jobs/:ticker/:interval[/(pause|resume|fetch)]
  const m = path.match(/^\/api\/jobs\/([^/]+)\/([^/]+)(?:\/(pause|resume|fetch))?$/);
  if (m) {
    const ticker = decodeURIComponent(m[1]);
    const interval = decodeURIComponent(m[2]);
    const action = m[3];
    if (method === 'GET' && !action) return apiJobDetail(env, ticker, interval);
    if (method === 'POST' && action === 'pause') return apiSetActive(env, ticker, interval, 0);
    if (method === 'POST' && action === 'resume') return apiSetActive(env, ticker, interval, 1);
    if (method === 'POST' && action === 'fetch') return apiFetchOne(env, ctx, ticker, interval);
  }
  return jsonErr('Not Found', 404);
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function jsonErr(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ---- 普通 handlers ---------------------------------------------------------

async function apiHealth(env: Env): Promise<Response> {
  const r = await env.market_data_lake.prepare(
    `SELECT
       COUNT(*)                                                AS total,
       COALESCE(SUM(CASE WHEN is_active = 1 AND error_flag = 0 THEN 1 ELSE 0 END), 0) AS active,
       COALESCE(SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END), 0) AS paused,
       COALESCE(SUM(CASE WHEN error_flag = 1 THEN 1 ELSE 0 END), 0) AS errors,
       MAX(last_updated_at)                                    AS lastCronAt
     FROM ticker_intervals`,
  ).first<{ total: number; active: number; paused: number; errors: number; lastCronAt: number | null }>();
  return jsonOk(r ?? { total: 0, active: 0, paused: 0, errors: 0, lastCronAt: null });
}

async function apiJobsList(env: Env, url: URL): Promise<Response> {
  const market = url.searchParams.get('market');
  const interval = url.searchParams.get('interval');
  const status = url.searchParams.get('status');
  const q = (url.searchParams.get('q') ?? '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10)));

  const where: string[] = [];
  const params: unknown[] = [];
  if (market) { where.push('t.market = ?'); params.push(market); }
  if (interval) { where.push('ti.interval = ?'); params.push(interval); }
  if (status === 'active') where.push('ti.is_active = 1 AND ti.error_flag = 0');
  if (status === 'paused') where.push('ti.is_active = 0');
  if (status === 'error') where.push('ti.error_flag = 1');
  if (q) {
    // 模糊搜索 ticker 或 name；转义 LIKE 通配符避免被搜索词当成模式
    const esc = q.replace(/[\\%_]/g, (c) => '\\' + c);
    const pat = `%${esc}%`;
    where.push("(ti.ticker LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\')");
    params.push(pat, pat);
  }

  const sql = `SELECT ti.ticker, t.name, t.market, ti.interval, ti.is_active, ti.last_updated_at,
                      ti.error_flag, ti.error_message, ti.error_count, ti.row_count,
                      ti.data_start_at, ti.data_end_at
                 FROM ticker_intervals ti
                 JOIN tickers t ON t.ticker = ti.ticker
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY t.market, ti.ticker, ti.interval
                 LIMIT ? OFFSET ?`;
  params.push(pageSize, (page - 1) * pageSize);

  const { results } = await env.market_data_lake.prepare(sql).bind(...params).all();
  return jsonOk({ data: results ?? [], page, pageSize });
}

async function apiJobDetail(env: Env, ticker: string, interval: string): Promise<Response> {
  const row = await env.market_data_lake.prepare(
    `SELECT ti.ticker, t.name, t.market, ti.interval, ti.is_active, ti.last_updated_at,
            ti.error_flag, ti.error_message, ti.error_count, ti.row_count,
            ti.data_start_at, ti.data_end_at
       FROM ticker_intervals ti
       JOIN tickers t ON t.ticker = ti.ticker
      WHERE ti.ticker = ? AND ti.interval = ?`,
  )
    .bind(ticker, interval)
    .first<JobRow & { market: Market; name: string | null }>();
  if (!row) return jsonErr('Not Found', 404);

  const s3 = createS3Client(env);
  const preview = await tailCsv(s3, objectKey(row.market, row.interval, row.ticker), 50);
  return jsonOk({ ...row, preview });
}

async function apiSetActive(env: Env, ticker: string, interval: string, value: 0 | 1): Promise<Response> {
  const r = await env.market_data_lake.prepare(
    `UPDATE ticker_intervals SET is_active = ? WHERE ticker = ? AND interval = ?`,
  )
    .bind(value, ticker, interval)
    .run();
  if ((r.meta?.changes ?? 0) === 0) return jsonErr('Not Found', 404);
  return jsonOk({ ok: true });
}

/** 单只股票立即拉取（fetchOneJob via ctx.waitUntil；30s 内 dashboard 自动刷新可见结果） */
async function apiFetchOne(
  env: Env,
  ctx: ExecutionContext,
  ticker: string,
  interval: string,
): Promise<Response> {
  const job = await env.market_data_lake
    .prepare(
      `SELECT ti.ticker, ti.interval, ti.is_active, ti.last_updated_at,
              ti.error_flag, ti.error_message, ti.error_count, ti.row_count,
              ti.data_start_at, ti.data_end_at,
              t.market, t.name
         FROM ticker_intervals ti
         JOIN tickers t ON t.ticker = ti.ticker
        WHERE ti.ticker = ? AND ti.interval = ?`,
    )
    .bind(ticker, interval)
    .first<TickerJob>();
  if (!job) return jsonErr('Not Found', 404);

  const s3 = createS3Client(env);
  ctx.waitUntil(fetchOneJob(env, s3, job));
  return jsonOk({ ok: true, message: `Fetch ${ticker} ${interval} triggered` });
}

// ---- 系统级 handlers -------------------------------------------------------

async function apiSystemGet(env: Env): Promise<Response> {
  const { results } = await env.market_data_lake
    .prepare(`SELECT key, value FROM system_config WHERE key IN ('cron_enabled','cron_schedule')`)
    .all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const r of results ?? []) map[r.key] = r.value;
  return jsonOk({
    cron_enabled: map.cron_enabled === '1',
    cron_schedule: map.cron_schedule ?? '*/2 * * * *',
  });
}

async function apiSystemCronToggle(env: Env): Promise<Response> {
  await env.market_data_lake
    .prepare(
      `UPDATE system_config
          SET value = CASE WHEN value = '1' THEN '0' ELSE '1' END
        WHERE key = 'cron_enabled'`,
    )
    .run();
  return apiSystemGet(env);
}

/** 立即手动触发一次抓取批次（不等结果，dashboard 30s 自动刷新可见） */
async function apiSystemRun(env: Env, ctx: ExecutionContext): Promise<Response> {
  ctx.waitUntil(runScheduled(env).then(() => undefined));
  return jsonOk({ ok: true, message: 'Cron run triggered in background' });
}

/** 同步跑一波，等结果返回 —— 诊断用，能直接看到 picked/succeeded/failed 计数 */
async function apiSystemRunSync(env: Env): Promise<Response> {
  const result = await runScheduled(env);
  return jsonOk(result);
}

/** 一次性快照诊断：D1 实际状态 + 队列下一波要抓的 + 错误样本 */
async function apiSystemDiag(env: Env): Promise<Response> {
  const now = Date.now();

  const counts = await env.market_data_lake
    .prepare(
      `SELECT
         COUNT(*)                                                AS total,
         SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END)          AS active,
         SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END)          AS paused,
         SUM(CASE WHEN error_flag = 1 THEN 1 ELSE 0 END)         AS errors,
         SUM(CASE WHEN last_updated_at = 0 THEN 1 ELSE 0 END)    AS never_updated,
         SUM(CASE WHEN last_updated_at > 0 THEN 1 ELSE 0 END)    AS ever_updated,
         MAX(last_updated_at)                                    AS last_run_at,
         SUM(error_count)                                        AS total_error_count
       FROM ticker_intervals`,
    )
    .first<{
      total: number; active: number; paused: number; errors: number;
      never_updated: number; ever_updated: number;
      last_run_at: number | null; total_error_count: number;
    }>();

  const stale = await env.market_data_lake
    .prepare(
      `SELECT ticker, interval, last_updated_at, error_flag, error_count, error_message
         FROM ticker_intervals
        WHERE is_active = 1
        ORDER BY last_updated_at ASC
        LIMIT 5`,
    )
    .all();

  const errs = await env.market_data_lake
    .prepare(
      `SELECT ticker, interval, error_count, error_message, last_updated_at
         FROM ticker_intervals
        WHERE error_flag = 1
        ORDER BY error_count DESC
        LIMIT 5`,
    )
    .all();

  const sys = await env.market_data_lake.prepare(`SELECT key, value FROM system_config`).all();

  return jsonOk({
    now,
    iso_now: new Date(now).toISOString(),
    counts,
    minutes_since_last_run:
      counts?.last_run_at && counts.last_run_at > 0
        ? Math.round((now - counts.last_run_at) / 60000)
        : null,
    last_run_iso: counts?.last_run_at ? new Date(counts.last_run_at).toISOString() : null,
    next_oldest: stale.results,
    error_samples: errs.results,
    system_config: sys.results,
  });
}

/**
 * 批量导入某市场的全部标的清单：
 *   - US：NASDAQ Trader 公开 listing 文件（~7000）
 *   - CN：东方财富全 A 股清单（~5000）
 *   - HK：硬编码 HSI 主要成分股（~80）
 * 所有插入用 INSERT OR IGNORE，重复执行幂等。导入后默认抓 1d。
 */
async function apiSystemImport(env: Env, url: URL): Promise<Response> {
  const market = url.searchParams.get('market') as Market | null;
  if (market !== 'US' && market !== 'HK' && market !== 'CN') {
    return jsonErr('market must be US/HK/CN', 400);
  }

  const items = await fetchListings(market);
  if (items.length === 0) return jsonOk({ market, fetched: 0, inserted: 0 });

  // 分块 multi-VALUES INSERT：D1 单语句占位符上限 100
  // tickers 一行 3 个占位符（ticker/market/name），30 行 × 3 = 90 留余量；
  // ticker_intervals 一行 2 个占位符，40 行 × 2 = 80。
  const CHUNK_T = 30;
  const CHUNK_J = 40;
  let insertedTickers = 0;
  let insertedJobs = 0;

  for (let i = 0; i < items.length; i += CHUNK_T) {
    const chunk = items.slice(i, i + CHUNK_T);
    const ph = chunk.map(() => '(?, ?, ?)').join(',');
    const p = chunk.flatMap((t) => [t.ticker, t.market, t.name]);
    // ON CONFLICT DO UPDATE：让重复导入也能刷新 name（公司改名 / 第一次没拿到名时补回）
    const r = await env.market_data_lake
      .prepare(
        `INSERT INTO tickers (ticker, market, name) VALUES ${ph}
           ON CONFLICT(ticker) DO UPDATE SET
             name = excluded.name,
             market = excluded.market`,
      )
      .bind(...p)
      .run();
    insertedTickers += r.meta?.changes ?? 0;
  }

  for (let i = 0; i < items.length; i += CHUNK_J) {
    const chunk = items.slice(i, i + CHUNK_J);
    const ph = chunk.map(() => '(?, ?)').join(',');
    const p = chunk.flatMap((t) => [t.ticker, '1d']);
    const r = await env.market_data_lake
      .prepare(`INSERT OR IGNORE INTO ticker_intervals (ticker, interval) VALUES ${ph}`)
      .bind(...p)
      .run();
    insertedJobs += r.meta?.changes ?? 0;
  }

  return jsonOk({
    market,
    fetched: items.length,
    inserted_tickers: insertedTickers,
    inserted_jobs: insertedJobs,
  });
}

/**
 * 批量 / 全部 Fetch：把候选行的 last_updated_at 置 0 → cron 下一波优先抓；并立即触发一次 runScheduled。
 * 自动跳过 row_count 已 ≥ EXPECTED_BARS[interval] 的"满格"行。
 *
 * Body 两种模式：
 *   { scope: 'list', tickers: [{ticker, interval}, ...] }   —— UI 多选
 *   { scope: 'filter', filter: { market?, interval?, status?, q? } } —— Fetch all matching
 */
async function apiFetchBulk(env: Env, ctx: ExecutionContext, req: Request): Promise<Response> {
  type Body = {
    scope?: 'list' | 'filter';
    filter?: { market?: string; interval?: string; status?: string; q?: string };
    tickers?: Array<{ ticker: string; interval: string }>;
  };
  const body = (await req.json().catch(() => ({}))) as Body;

  type Cand = { ticker: string; interval: Interval; row_count: number };
  let candidates: Cand[] = [];

  if (body.scope === 'list' && body.tickers && body.tickers.length > 0) {
    // 用 (ticker, interval) IN VALUES，按 40 行/批避开 100 占位符上限
    const CHUNK = 40;
    for (let i = 0; i < body.tickers.length; i += CHUNK) {
      const chunk = body.tickers.slice(i, i + CHUNK);
      const ph = chunk.map(() => '(?, ?)').join(',');
      const p = chunk.flatMap((t) => [t.ticker, t.interval]);
      const { results } = await env.market_data_lake
        .prepare(
          `SELECT ticker, interval, row_count FROM ticker_intervals
            WHERE (ticker, interval) IN (VALUES ${ph})`,
        )
        .bind(...p)
        .all<Cand>();
      candidates.push(...(results ?? []));
    }
  } else {
    // filter 模式（默认）
    const where: string[] = [];
    const params: unknown[] = [];
    const f = body.filter ?? {};
    if (f.market) { where.push('t.market = ?'); params.push(f.market); }
    if (f.interval) { where.push('ti.interval = ?'); params.push(f.interval); }
    if (f.status === 'active') where.push('ti.is_active = 1 AND ti.error_flag = 0');
    else if (f.status === 'paused') where.push('ti.is_active = 0');
    else if (f.status === 'error') where.push('ti.error_flag = 1');
    else where.push('ti.is_active = 1'); // 默认仅活跃
    if (f.q) {
      const esc = f.q.replace(/[\\%_]/g, (c) => '\\' + c);
      const pat = `%${esc}%`;
      where.push("(ti.ticker LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\')");
      params.push(pat, pat);
    }
    const sql = `SELECT ti.ticker, ti.interval, ti.row_count
                   FROM ticker_intervals ti
                   JOIN tickers t ON t.ticker = ti.ticker
                  WHERE ${where.join(' AND ')}`;
    const { results } = await env.market_data_lake.prepare(sql).bind(...params).all<Cand>();
    candidates = results ?? [];
  }

  // 跳过已达 100%
  const eligible = candidates.filter(
    (c) => (c.row_count ?? 0) < (EXPECTED_BARS[c.interval] ?? Infinity),
  );
  const skipped = candidates.length - eligible.length;

  // 批量 promote 到队列头：last_updated_at = 0
  const CHUNK = 40;
  for (let i = 0; i < eligible.length; i += CHUNK) {
    const chunk = eligible.slice(i, i + CHUNK);
    const ph = chunk.map(() => '(?, ?)').join(',');
    const p = chunk.flatMap((c) => [c.ticker, c.interval]);
    await env.market_data_lake
      .prepare(
        `UPDATE ticker_intervals SET last_updated_at = 0
          WHERE (ticker, interval) IN (VALUES ${ph})`,
      )
      .bind(...p)
      .run();
  }

  // 立刻拉一波（runScheduled 会取 last_updated_at 最旧的 20 条 = 我们刚 promote 的）
  if (eligible.length > 0) ctx.waitUntil(runScheduled(env));

  return jsonOk({
    matched: candidates.length,
    queued: eligible.length,
    skipped,
  });
}
