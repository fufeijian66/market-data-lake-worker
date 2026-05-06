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
//   = 4 × (50×4 + 1) + 2 = 806，仍 fit 1000
//
// cron `* * * * *`（1 分钟一次） + 每分钟 4 轮 × 50 = 200 个/min，
// 3658 条全量约 18 分钟扫完一遍（旧版 *5min × 50 = 6h）。
//
// 如果回退 Free tier：BATCH_SIZE = 8，ROUNDS = 1，total = 8×4+3 = 35，fit 50。
const BATCH_SIZE = 50;
const ROUNDS = 4;

// 失败熔断：连续失败到这个次数自动 is_active = 0，避免坏标的反复挤占 batch 名额
// 管理后台手动 resume 后 error_count 不会自动清零，但下一次成功会清；想强制清零
// 可手动 fetch 一次或在 D1 直接 UPDATE。
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

    const results = await Promise.allSettled(jobs.map((job) => fetchOneJob(env, s3, job)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === true) succeeded++;
      else failed++;
    }
  }

  console.log(`[cron] done: picked=${picked} ok=${succeeded} failed=${failed}`);
  return { picked, succeeded, failed };
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
 * 失败时：
 *  1. error_count + 1
 *  2. last_updated_at = now() 让该行下沉到队列末尾，避免坏标的反复挤占名额
 *  3. error_count 达到 ERROR_DISABLE_THRESHOLD 后自动 is_active = 0，需要管理员手动 resume
 *     管理员手动 fetch 成功会清 error_flag 但不清 error_count；如果想恢复"重试预算"
 *     可以在后台对该行直接 UPDATE error_count = 0。
 */
async function markFailure(env: Env, job: TickerJob, msg: string): Promise<void> {
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
    .bind(msg.slice(0, 500), ERROR_DISABLE_THRESHOLD, Date.now(), job.ticker, job.interval)
    .run();
}
