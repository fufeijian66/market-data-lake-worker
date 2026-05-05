// S3 工具：基于 aws4fetch 的 SigV4 签名 + Read-Merge-Overwrite + tail 预览
// 强制使用标准 S3 SigV4 协议，禁用 R2 binding（架构红线 #1）
//
// 历史决策：原计划用 @aws-sdk/client-s3，但该 SDK 在 Cloudflare Workers 上即使开 nodejs_compat
// 仍偶发 import / 运行期崩溃（@smithy/* 子依赖与 Workers 运行时不兼容）。aws4fetch 是
// Cloudflare 官方推荐的轻量替代（约 5KB，零 Node 依赖），纯 fetch + SigV4 签名，
// 跨云 S3-兼容服务（R2 / 阿里云 OSS / MinIO / AWS S3）通用。架构红线意图（标准 S3 协议、
// 禁 R2 binding、跨云迁移）保持不变。

import { AwsClient } from 'aws4fetch';
import type { Env, OHLCV } from './types';

const CSV_HEADER = 'Datetime,Open,High,Low,Close,Volume';

/** S3 调用上下文（凭证只走 env，架构红线 #2） */
export interface S3Ctx {
  client: AwsClient;
  bucket: string;
  endpoint: string;
}

export function createS3Client(env: Env): S3Ctx {
  const client = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    service: 's3',
    region: env.S3_REGION,
  });
  return {
    client,
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT.replace(/\/$/, ''),
  };
}

/** 对象 Key 格式（架构红线 #3）：{Market}/{Interval}/{Ticker}.csv */
export function objectKey(market: string, interval: string, ticker: string): string {
  return `${market}/${interval}/${ticker}.csv`;
}

/**
 * Virtual-hosted style URL：https://{bucket}.{endpoint-host}/{key}
 * 阿里云 OSS S3 兼容接口**强制**要求 virtual-hosted style；AWS S3 / R2 / MinIO 也都支持，
 * 所以无脑选这个最兼容（path-style 在 OSS 上会返回 403 AccessDenied）。
 */
function objectUrl(ctx: S3Ctx, key: string): string {
  const u = new URL(ctx.endpoint);
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${u.protocol}//${ctx.bucket}.${u.host}/${encoded}`;
}

function parseCsv(text: string): OHLCV[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0 || lines[0] === '') return [];
  const start = lines[0].startsWith('Datetime,') ? 1 : 0;
  const out: OHLCV[] = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 6) continue;
    const open = Number(cols[1]);
    if (!Number.isFinite(open)) continue;
    out.push({
      Datetime: cols[0],
      Open: open,
      High: Number(cols[2]),
      Low: Number(cols[3]),
      Close: Number(cols[4]),
      Volume: Number(cols[5]),
    });
  }
  return out;
}

function toCsv(rows: OHLCV[]): string {
  const body = rows
    .map((r) => `${r.Datetime},${r.Open},${r.High},${r.Low},${r.Close},${r.Volume}`)
    .join('\n');
  return `${CSV_HEADER}\n${body}\n`;
}

async function getObjectText(
  ctx: S3Ctx,
  key: string,
): Promise<{ found: true; text: string } | { found: false }> {
  const resp = await ctx.client.fetch(objectUrl(ctx, key));
  if (resp.status === 404) return { found: false };
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`S3 GET ${key} HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  return { found: true, text: await resp.text() };
}

async function putObject(ctx: S3Ctx, key: string, body: string, contentType: string): Promise<void> {
  const resp = await ctx.client.fetch(objectUrl(ctx, key), {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType },
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`S3 PUT ${key} HTTP ${resp.status} ${errBody.slice(0, 200)}`);
  }
}

/**
 * Read-Merge-Overwrite（架构红线 #6）：
 *   GET → 解析 CSV → 合并新数据 → 按 Datetime 去重升序 → PUT 覆盖
 *   404 当作空数组处理，不视为错误
 *   返回值含整体范围（dataStart/dataEnd），由调用方写回 D1
 */
export async function mergeAndUpload(
  ctx: S3Ctx,
  key: string,
  fresh: OHLCV[],
): Promise<{
  total: number;
  newlyAdded: number;
  dataStart: string | null;
  dataEnd: string | null;
}> {
  const got = await getObjectText(ctx, key);
  const existing = got.found ? parseCsv(got.text) : [];

  const dedup = new Map<string, OHLCV>();
  for (const row of existing) dedup.set(row.Datetime, row);
  const before = dedup.size;
  for (const row of fresh) dedup.set(row.Datetime, row);
  const merged = Array.from(dedup.values()).sort((a, b) =>
    a.Datetime < b.Datetime ? -1 : a.Datetime > b.Datetime ? 1 : 0,
  );

  await putObject(ctx, key, toCsv(merged), 'text/csv; charset=utf-8');
  return {
    total: merged.length,
    newlyAdded: merged.length - before,
    dataStart: merged.length > 0 ? merged[0].Datetime : null,
    dataEnd: merged.length > 0 ? merged[merged.length - 1].Datetime : null,
  };
}

/** 取末尾 N 行 CSV，后台「单作业详情」预览用 */
export async function tailCsv(
  ctx: S3Ctx,
  key: string,
  n: number,
): Promise<{ header: string; rows: string[] }> {
  const got = await getObjectText(ctx, key);
  if (!got.found) return { header: CSV_HEADER, rows: [] };
  const lines = got.text.trim().split(/\r?\n/);
  if (lines.length === 0) return { header: CSV_HEADER, rows: [] };
  const hasHeader = lines[0].startsWith('Datetime,');
  const header = hasHeader ? lines[0] : CSV_HEADER;
  const body = hasHeader ? lines.slice(1) : lines;
  return { header, rows: body.slice(-n) };
}
