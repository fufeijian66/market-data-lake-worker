// HTTP 路由分发：/admin（HTML） + /api/*（JSON）
// 任何路由进入业务逻辑前必先过 access-auth 中间件（架构红线 #9）

import type { Env, JobRow, Market } from './types';
import { requireAccess } from './access-auth';
import { createS3Client, objectKey, tailCsv } from './s3';
import { ADMIN_HTML } from './admin-ui';

export async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/') {
    return guarded(req, env, () =>
      new Response(ADMIN_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
  }
  if (url.pathname.startsWith('/api/')) {
    return guarded(req, env, () => handleApi(req, env, url));
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

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (method === 'GET' && path === '/api/health') return apiHealth(env);
  if (method === 'GET' && path === '/api/jobs') return apiJobsList(env, url);

  // /api/jobs/:ticker/:interval[/(pause|resume|retry)]
  const m = path.match(/^\/api\/jobs\/([^/]+)\/([^/]+)(?:\/(pause|resume|retry))?$/);
  if (m) {
    const ticker = decodeURIComponent(m[1]);
    const interval = decodeURIComponent(m[2]);
    const action = m[3];
    if (method === 'GET' && !action) return apiJobDetail(env, ticker, interval);
    if (method === 'POST' && action === 'pause') return apiSetActive(env, ticker, interval, 0);
    if (method === 'POST' && action === 'resume') return apiSetActive(env, ticker, interval, 1);
    if (method === 'POST' && action === 'retry') return apiRetry(env, ticker, interval);
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

// ---- handlers ---------------------------------------------------------------

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
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10)));

  const where: string[] = [];
  const params: unknown[] = [];
  if (market) { where.push('t.market = ?'); params.push(market); }
  if (interval) { where.push('ti.interval = ?'); params.push(interval); }
  if (status === 'active') where.push('ti.is_active = 1 AND ti.error_flag = 0');
  if (status === 'paused') where.push('ti.is_active = 0');
  if (status === 'error') where.push('ti.error_flag = 1');

  const sql = `SELECT ti.ticker, t.market, ti.interval, ti.is_active, ti.last_updated_at,
                      ti.error_flag, ti.error_message, ti.error_count
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
    `SELECT ti.ticker, t.market, ti.interval, ti.is_active, ti.last_updated_at,
            ti.error_flag, ti.error_message, ti.error_count
       FROM ticker_intervals ti
       JOIN tickers t ON t.ticker = ti.ticker
      WHERE ti.ticker = ? AND ti.interval = ?`,
  )
    .bind(ticker, interval)
    .first<JobRow & { market: Market }>();
  if (!row) return jsonErr('Not Found', 404);

  // S3 末尾 N 行预览
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

async function apiRetry(env: Env, ticker: string, interval: string): Promise<Response> {
  // 清错误标记 + 把 last_updated_at 设为 0 → 下一轮 Cron 优先抓
  const r = await env.market_data_lake.prepare(
    `UPDATE ticker_intervals
        SET error_flag = 0,
            error_message = NULL,
            last_updated_at = 0
      WHERE ticker = ? AND interval = ?`,
  )
    .bind(ticker, interval)
    .run();
  if ((r.meta?.changes ?? 0) === 0) return jsonErr('Not Found', 404);
  return jsonOk({ ok: true });
}
