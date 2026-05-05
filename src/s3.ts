// S3 工具：S3Client 工厂 + Read-Merge-Overwrite + tail 预览
// 强制使用 @aws-sdk/client-s3，禁用 R2 binding（架构红线 #1）

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Env, OHLCV } from './types';

const CSV_HEADER = 'Datetime,Open,High,Low,Close,Volume';

/** 从 env 初始化 S3Client，凭证只走 env，禁止硬编码（架构红线 #2） */
export function createS3Client(env: Env): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    // R2 等 S3-兼容服务通常需要 forcePathStyle，AWS S3 默认 false 也能跑
    forcePathStyle: true,
  });
}

/** 对象 Key 格式（架构红线 #3）：{Market}/{Interval}/{Ticker}.csv */
export function objectKey(market: string, interval: string, ticker: string): string {
  return `${market}/${interval}/${ticker}.csv`;
}

/** SDK v3 GetObject.Body 在 Workers 是 ReadableStream / Blob，统一吸成字符串 */
async function bodyToString(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  // 用 Response 包装最稳：能吃 ReadableStream / Blob / ArrayBuffer
  return await new Response(body as BodyInit).text();
}

function parseCsv(text: string): OHLCV[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0 || lines[0] === '') return [];
  // 兼容历史文件可能没有表头：检测第一行是否表头
  const start = lines[0].startsWith('Datetime,') ? 1 : 0;
  const out: OHLCV[] = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 6) continue;
    const open = Number(cols[1]);
    if (!Number.isFinite(open)) continue; // 跳过坏行（如尾部空行）
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

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Read-Merge-Overwrite（架构红线 #6）：
 *   GetObject → 解析 CSV → 合并新数据 → 按 Datetime 去重升序 → PutObject 覆盖
 *   NoSuchKey / 404 当作空数组处理，不视为错误
 */
export async function mergeAndUpload(
  s3: S3Client,
  bucket: string,
  key: string,
  fresh: OHLCV[],
): Promise<{ total: number; newlyAdded: number }> {
  let existing: OHLCV[] = [];
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await bodyToString(obj.Body);
    existing = parseCsv(text);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const dedup = new Map<string, OHLCV>();
  for (const row of existing) dedup.set(row.Datetime, row);
  const before = dedup.size;
  for (const row of fresh) dedup.set(row.Datetime, row); // 新数据覆盖旧数据
  const merged = Array.from(dedup.values()).sort((a, b) =>
    a.Datetime < b.Datetime ? -1 : a.Datetime > b.Datetime ? 1 : 0,
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: toCsv(merged),
      ContentType: 'text/csv; charset=utf-8',
    }),
  );

  return { total: merged.length, newlyAdded: merged.length - before };
}

/** 取末尾 N 行 CSV（含表头），后台「单作业详情」预览用 */
export async function tailCsv(
  s3: S3Client,
  bucket: string,
  key: string,
  n: number,
): Promise<{ header: string; rows: string[] }> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await bodyToString(obj.Body);
    const lines = text.trim().split(/\r?\n/);
    if (lines.length === 0) return { header: CSV_HEADER, rows: [] };
    const hasHeader = lines[0].startsWith('Datetime,');
    const header = hasHeader ? lines[0] : CSV_HEADER;
    const body = hasHeader ? lines.slice(1) : lines;
    return { header, rows: body.slice(-n) };
  } catch (err) {
    if (isNotFound(err)) return { header: CSV_HEADER, rows: [] };
    throw err;
  }
}
