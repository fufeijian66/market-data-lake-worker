// 数据源统一调度入口

import type { Market, Interval, OHLCV } from '../types';
import { fetchYahoo } from './yahoo';
import { fetchEastmoney } from './eastmoney';

/**
 * 选择数据源：
 *   - US / HK：Yahoo Finance
 *   - CN 全粒度：东方财富（新浪 datalen 上限 1023 太小已弃用）
 *
 * dataEndAt 是上次合并后 S3 里最末一根 K 线的 ISO 8601 时间。两个数据源都
 * 据此决定增量窗口（首抓全量，后续小窗口）—— 没有这个增量优化，每次 cron
 * 都重新拉 30 年数据 + 在 Worker 里 sort/dedup 几万行，CPU 与带宽双倍浪费。
 *
 * 备注：src/sources/sina.ts 仍保留作为可切换的备用源；调度统一走东方财富。
 */
export async function fetchOHLCV(
  market: Market,
  ticker: string,
  interval: Interval,
  dataEndAt: string | null = null,
): Promise<OHLCV[]> {
  if (market === 'US' || market === 'HK') return fetchYahoo(ticker, interval, dataEndAt);
  if (market === 'CN') return fetchEastmoney(ticker, interval, dataEndAt);
  throw new Error(`Unsupported market: ${market}`);
}
