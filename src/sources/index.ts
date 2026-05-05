// 数据源统一调度入口

import type { Market, Interval, OHLCV } from '../types';
import { fetchYahoo } from './yahoo';
import { fetchEastmoney } from './eastmoney';

/**
 * 选择数据源：
 *   - US / HK：Yahoo Finance（1d/1wk/1mo 用 range=max 拉全历史）
 *   - CN 全粒度：东方财富（lmt=10000 ≈ 40 年日线；新浪 datalen 上限 1023 太小已弃用）
 *
 * 备注：src/sources/sina.ts 仍保留作为可切换的备用源；调度统一走东方财富。
 */
export async function fetchOHLCV(
  market: Market,
  ticker: string,
  interval: Interval,
): Promise<OHLCV[]> {
  if (market === 'US' || market === 'HK') return fetchYahoo(ticker, interval);
  if (market === 'CN') return fetchEastmoney(ticker, interval);
  throw new Error(`Unsupported market: ${market}`);
}
