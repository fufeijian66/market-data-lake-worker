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

// Yahoo 的历史窗口 vs 粒度限制（agent-spec.md「已知约束」节）
// 大粒度（1d/1wk/1mo）改 'max' 拉全部历史（可达 30+ 年），小粒度仍受 Yahoo 服务端约束
const RANGE_FOR_INTERVAL: Record<Interval, string> = {
  '1m':  '7d',
  '5m':  '60d',
  '15m': '60d',
  '30m': '60d',
  '1h':  '730d',
  '1d':  'max',
  '1wk': 'max',
  '1mo': 'max',
};

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

export async function fetchYahoo(symbol: string, interval: Interval): Promise<OHLCV[]> {
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  url.searchParams.set('interval', interval);
  url.searchParams.set('range', RANGE_FOR_INTERVAL[interval]);
  url.searchParams.set('includePrePost', 'false');

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': pickUA(), Accept: 'application/json' },
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
