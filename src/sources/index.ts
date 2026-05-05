// 数据源统一调度入口

import type { Market, Interval, OHLCV } from '../types';
import { fetchYahoo } from './yahoo';
import { fetchSina } from './sina';
import { fetchEastmoney } from './eastmoney';

/**
 * 选择数据源（agent-spec.md「数据源」节）：
 *   - US / HK：Yahoo Finance
 *   - CN 日线：新浪（接口稳定、字段干净）
 *   - CN 其它粒度：东方财富（小粒度 + 周/月线）
 */
export async function fetchOHLCV(
  market: Market,
  ticker: string,
  interval: Interval,
): Promise<OHLCV[]> {
  if (market === 'US' || market === 'HK') return fetchYahoo(ticker, interval);
  if (market === 'CN') {
    return interval === '1d' ? fetchSina(ticker, interval) : fetchEastmoney(ticker, interval);
  }
  // CHECK 约束已经在 D1 schema 上保证 market 取值，这里是兜底
  throw new Error(`Unsupported market: ${market}`);
}
