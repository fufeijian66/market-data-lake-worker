// Cron Trigger 主流程（架构红线 #8）：
//   1. 从 ticker_intervals 取 is_active=1 中 last_updated_at 最旧的 20 条
//   2. 并发抓取 → Read-Merge-Overwrite 写 S3
//   3. 单条失败不阻断整批：用 Promise.allSettled

import type { Env, TickerJob } from './types';
import { createS3Client, mergeAndUpload, objectKey, type S3Ctx } from './s3';
import { fetchOHLCV } from './sources';

// Workers 子请求上限：Free 50 / Paid 1000 per invocation。
// 每个 job 4 个 subrequest（fetchOHLCV + S3 GET + S3 PUT + D1 UPDATE）。
//
// Paid tier 单次 invocation 跑 ROUNDS × BATCH_SIZE 个作业：
//   subrequest = ROUNDS × (BATCH_SIZE × 4 + 1 pickOldest) + 2 (heartbeat + cron_enabled)
//   = 2 × (50×4 + 1) + 2 = 404，远低于 1000 上限
//
// cron `*/2 * * * *` + 每次 2 轮 × 50 = 100 个/2min = 50 jobs/min，
// 3658 条全量约 1.2 小时扫完一遍（旧版 */5min × 50 = 6h）。
// 之前试过 */1min × 4 轮 × 50 = 200/min，把东方财富顶出 520，故收敛到这个量级。
//
// 如果回退 Free tier：BATCH_SIZE = 8，ROUNDS = 1，total = 8×4+3 = 35，fit 50。
const BATCH_SIZE = 50;
const ROUNDS = 2;

// 东方财富对 push2his 公益接口稳定性差，并发一高直接 502/520。
// CN/HK 标的在每批内串行执行，相邻请求间隔 EASTMONEY_GAP_MS。Yahoo (US) 仍并发。
const EASTMONEY_GAP_MS = 150;

// 失败熔断：连续"永久失败"达此阈值自动 is_active = 0；可重试错误（5xx/429/超时）不计数。
const ERROR_DISABLE_THRESHOLD = 10;

export async function runScheduled(env: Env): Promise<{
  picked: number;
  succeeded: number;
  failed: number;
}> {
  // 心跳：无论 enabled 与否、是否取到 jobs，只要 scheduled handler 被触发就写一行。
  // 如果心跳不更新 = Cloudflare cron 触发层根本没接到事件。
  await env.market_data_lake
    .prepare(`INSERT OR REPLACE INTO system_config (key, value) VALUES ('cron_heartbeat', ?)`)
    .bind(String(Date.now()))
    .run();

  const flag = await env.market_data_lake
    .prepare(`SELECT value FROM system_config WHERE key = 'cron_enabled'`)
    .first<{ value: string }>();
  if (flag?.value !== '1') {
    console.log('[cron] disabled via system_config.cron_enabled, skipping');
    return { picked: 0, succeeded: 0, failed: 0 };
  }

  const s3 = createS3Client(env);
  let picked = 0;
  let succeeded = 0;
  let failed = 0;

  // 多轮：同一次 invocation 内连跑多批，每批从 D1 重新挑最旧的。
  // 上一轮成功的会 last_updated_at = now() 沉到队列尾，下一轮自然取到下一批新的。
  for (let round = 0; round < ROUNDS; round++) {
    const jobs = await pickOldestJobs(env, BATCH_SIZE);
    console.log(`[cron] round ${round + 1}/${ROUNDS}: picked ${jobs.length} jobs`);
    if (jobs.length === 0) break;
    picked += jobs.length;

    // 按数据源分流：US 走 Yahoo 全并发；CN/HK 走东方财富，串行 + 间隔，避免被 5xx
    const eastmoney: TickerJob[] = [];
    const others: TickerJob[] = [];
    for (const j of jobs) (j.market === 'CN' || j.market === 'HK' ? eastmoney : others).push(j);

    const [othersR, eastmoneyR] = await Promise.all([
      Promise.allSettled(others.map((job) => fetchOneJob(env, s3, job))),
      runSerialWithGap(env, s3, eastmoney, EASTMONEY_GAP_MS),
    ]);

    for (const r of othersR) {
      if (r.status === 'fulfilled' && r.value === true) succeeded++;
      else failed++;
    }
    for (const ok of eastmoneyR) (ok ? succeeded++ : failed++);
  }

  console.log(`[cron] done: picked=${picked} ok=${succeeded} failed=${failed}`);
  return { picked, succeeded, failed };
}

/** 串行执行作业，相邻请求间留 gapMs 间隔；fetchOneJob 内部已自吞异常，不会向上抛 */
async function runSerialWithGap(
  env: Env,
  s3: S3Ctx,
  jobs: TickerJob[],
  gapMs: number,
): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < jobs.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
    out.push(await fetchOneJob(env, s3, jobs[i]));
  }
  return out;
}

/**
 * 抓取并合并单个 (ticker, interval) 作业。
 * 由 cron 批处理 与 admin "Fetch now" 按钮共用。
 * 异常自吞并写入 D1 error_*，不会向上抛。
 * 返回 true 表示成功、false 表示失败（用于上层统计）。
 */
export async function fetchOneJob(env: Env, s3: S3Ctx, job: TickerJob): Promise<boolean> {
  const tag = `${job.market}/${job.interval}/${job.ticker}`;
  try {
    const fresh = await fetchOHLCV(job.market, job.ticker, job.interval, job.data_end_at);
    const key = objectKey(job.market, job.interval, job.ticker);
    const result = await mergeAndUpload(s3, key, fresh);
    await markSuccess(env, job, result);
    console.log(`[fetch] ${tag}: ok total=${result.total} (+${result.newlyAdded})`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[fetch] ${tag}: FAILED ${msg.slice(0, 200)}`);
    try {
      await markFailure(env, job, msg);
    } catch (markErr) {
      // markFailure 自身也可能因 subrequest 限额失败 — 不抛
      console.log(`[fetch] ${tag}: markFailure also failed: ${markErr instanceof Error ? markErr.message : markErr}`);
    }
    return false;
  }
}

async function pickOldestJobs(env: Env, n: number): Promise<TickerJob[]> {
  const { results } = await env.market_data_lake
    .prepare(
      `SELECT ti.ticker, ti.interval, ti.is_active, ti.last_updated_at,
              ti.error_flag, ti.error_message, ti.error_count, ti.row_count,
              ti.data_start_at, ti.data_end_at,
              t.market, t.name
         FROM ticker_intervals ti
         JOIN tickers t ON t.ticker = ti.ticker
        WHERE ti.is_active = 1
        ORDER BY ti.last_updated_at ASC
        LIMIT ?`,
    )
    .bind(n)
    .all<TickerJob>();
  return results ?? [];
}

interface MergeResult {
  total: number;
  dataStart: string | null;
  dataEnd: string | null;
}

async function markSuccess(env: Env, job: TickerJob, r: MergeResult): Promise<void> {
  await env.market_data_lake
    .prepare(
      `UPDATE ticker_intervals
          SET last_updated_at = ?,
              error_flag = 0,
              error_message = NULL,
              row_count = ?,
              data_start_at = ?,
              data_end_at = ?
        WHERE ticker = ? AND interval = ?`,
    )
    .bind(Date.now(), r.total, r.dataStart, r.dataEnd, job.ticker, job.interval)
    .run();
}

/**
 * 区分可重试错误（上游临时不可用）vs 永久错误（标的下架 / 代码改名 / 我们 bug）：
 *   - 5xx / 429 / 超时 / DNS 抖动 → 可重试，error_message 记录但 error_count 不增；
 *     last_updated_at 仍设 now() 让该行下沉，给其它健康作业让路
 *   - 其它（4xx 客户端错、解析错、空结果...） → 永久，error_count + 1，
 *     达 ERROR_DISABLE_THRESHOLD 自动 is_active = 0
 */
function isRetryable(msg: string): boolean {
  // AbortSignal.timeout 抛出来的消息形如 "The operation was aborted" / "TimeoutError"
  if (/abort|timeout/i.test(msg)) return true;
  // Yahoo 403 通常是上游反爬/区域封禁，不代表 ticker 永久失效，不能因此熔断停用。
  if (/^Yahoo .* HTTP 403$/.test(msg)) return true;
  // 我们在 sources/* 抛错时把 HTTP 状态码写进了 message
  const m = msg.match(/HTTP (\d{3})/);
  if (!m) return false;
  const code = Number(m[1]);
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

async function markFailure(env: Env, job: TickerJob, msg: string): Promise<void> {
  const truncated = msg.slice(0, 500);
  const now = Date.now();
  if (isRetryable(msg)) {
    await env.market_data_lake
      .prepare(
        `UPDATE ticker_intervals
            SET error_flag = 1,
                error_message = ?,
                last_updated_at = ?
          WHERE ticker = ? AND interval = ?`,
      )
      .bind(truncated, now, job.ticker, job.interval)
      .run();
    return;
  }
  await env.market_data_lake
    .prepare(
      `UPDATE ticker_intervals
          SET error_flag = 1,
              error_message = ?,
              error_count = error_count + 1,
              is_active = CASE WHEN error_count + 1 >= ? THEN 0 ELSE is_active END,
              last_updated_at = ?
        WHERE ticker = ? AND interval = ?`,
    )
    .bind(truncated, ERROR_DISABLE_THRESHOLD, now, job.ticker, job.interval)
    .run();
}
