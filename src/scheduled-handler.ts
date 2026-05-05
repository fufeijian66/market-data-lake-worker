// Cron Trigger 主流程（架构红线 #8）：
//   1. 从 ticker_intervals 取 is_active=1 中 last_updated_at 最旧的 20 条
//   2. 并发抓取 → Read-Merge-Overwrite 写 S3
//   3. 单条失败不阻断整批：用 Promise.allSettled

import type { Env, TickerJob } from './types';
import { createS3Client, mergeAndUpload, objectKey, type S3Ctx } from './s3';
import { fetchOHLCV } from './sources';

// Workers Free tier 限制：50 subrequests/invocation。每个 job 需要 4 个 subrequest
// (fetchOHLCV + S3 GET + S3 PUT + D1 UPDATE)，所以 BATCH_SIZE * 4 + 2(init queries) <= 50。
// 10 × 4 + 2 = 42，留 8 的 buffer。Workers Paid（$5/mo, 1000 subreq）可调到 50+。
const BATCH_SIZE = 10;

export async function runScheduled(env: Env): Promise<{
  picked: number;
  succeeded: number;
  failed: number;
}> {
  const flag = await env.market_data_lake
    .prepare(`SELECT value FROM system_config WHERE key = 'cron_enabled'`)
    .first<{ value: string }>();
  if (flag?.value !== '1') {
    console.log('[cron] disabled via system_config.cron_enabled, skipping');
    return { picked: 0, succeeded: 0, failed: 0 };
  }

  const jobs = await pickOldestJobs(env, BATCH_SIZE);
  console.log(`[cron] picked ${jobs.length} jobs`);
  if (jobs.length === 0) return { picked: 0, succeeded: 0, failed: 0 };

  const s3 = createS3Client(env);
  const results = await Promise.allSettled(jobs.map((job) => fetchOneJob(env, s3, job)));

  let succeeded = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value === true) succeeded++;
    else failed++;
  }
  console.log(`[cron] done: ${succeeded} ok, ${failed} failed`);
  return { picked: jobs.length, succeeded, failed };
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
    const fresh = await fetchOHLCV(job.market, job.ticker, job.interval);
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
 * 失败时同时更新 last_updated_at 让该行下沉到队列末尾，避免坏标的反复挤占 20 条名额。
 * error_count 单调递增；admin 触发 Fetch 成功后会清零（通过 markSuccess 覆盖）。
 */
async function markFailure(env: Env, job: TickerJob, msg: string): Promise<void> {
  await env.market_data_lake
    .prepare(
      `UPDATE ticker_intervals
          SET error_flag = 1,
              error_message = ?,
              error_count = error_count + 1,
              last_updated_at = ?
        WHERE ticker = ? AND interval = ?`,
    )
    .bind(msg.slice(0, 500), Date.now(), job.ticker, job.interval)
    .run();
}
