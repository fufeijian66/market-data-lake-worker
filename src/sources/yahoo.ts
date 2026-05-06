// Yahoo Finance 适配（US / HK）
// 端点：https://query1.finance.yahoo.com/v8/finance/chart/{Symbol}?interval=...&range=...

import type { Interval, OHLCV } from '../types';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
];
function pickUA(): string {
  return UAS[Math.floor(Math.random() * UAS.length)];
}

// 上游 fetch 超时（毫秒）。没有这个 Yahoo 偶发卡住会拖死整批 Promise.allSettled
const FETCH_TIMEOUT_MS = 8000;

// 首抓时拉全历史；增量更新时只拉一小段（覆盖最近的窗口 + 重叠去重靠 Datetime）
// Yahoo 只接受枚举 range：1d, 5d, 7d, 60d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max, 730d
const RANGE_FIRST_TIME: Record<Interval, string> = {
  '1m':  '7d',
  '5m':  '60d',
  '15m': '60d',
  '30m': '60d',
  '1h':  '730d',
  '1d':  'max',
  '1wk': 'max',
  '1mo': 'max',
};
const RANGE_INCREMENTAL: Record<Interval, string> = {
  '1m':  '1d',
  '5m':  '5d',
  '15m': '5d',
  '30m': '5d',
  '1h':  '7d',
  '1d':  '1mo',
  '1wk': '3mo',
  '1mo': '1y',
};

/**
 * 增量判定：data_end_at 在最近 N 天以内 → 用小窗口；否则用全历史。
 * N 故意取得比 RANGE_INCREMENTAL 略小，避免抓到的窗口与上次"擦肩而过"漏掉中间数据。
 */
const INCREMENTAL_THRESHOLD_DAYS: Record<Interval, number> = {
  '1m':  1,
  '5m':  3,
  '15m': 3,
  '30m': 3,
  '1h':  5,
  '1d':  20,
  '1wk': 60,
  '1mo': 300,
};

function pickRange(interval: Interval, dataEndAt: string | null): string {
  if (!dataEndAt) return RANGE_FIRST_TIME[interval];
  const end = Date.parse(dataEndAt);
  if (!Number.isFinite(end)) return RANGE_FIRST_TIME[interval];
  const daysSince = (Date.now() - end) / 86_400_000;
  return daysSince <= INCREMENTAL_THRESHOLD_DAYS[interval]
    ? RANGE_INCREMENTAL[interval]
    : RANGE_FIRST_TIME[interval];
}

interface YahooChartResp {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: { code: string; description: string };
  };
}

export async function fetchYahoo(
  symbol: string,
  interval: Interval,
  dataEndAt: string | null = null,
): Promise<OHLCV[]> {
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  url.searchParams.set('interval', interval);
  url.searchParams.set('range', pickRange(interval, dataEndAt));
  url.searchParams.set('includePrePost', 'false');

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': pickUA(), Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Yahoo ${symbol} ${interval} HTTP ${resp.status}`);

  const json = (await resp.json()) as YahooChartResp;
  if (json.chart?.error) {
    throw new Error(`Yahoo ${symbol}: ${json.chart.error.code} ${json.chart.error.description}`);
  }
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol} ${interval}: empty result`);
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) throw new Error(`Yahoo ${symbol} ${interval}: no quote`);

  const out: OHLCV[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    // 半小时盘前/盘后空 bar 跳过
    if (o == null || h == null || l == null || c == null) continue;
    out.push({
      Datetime: new Date(ts[i] * 1000).toISOString(),
      Open: o,
      High: h,
      Low: l,
      Close: c,
      Volume: v ?? 0,
    });
  }
  return out;
}
