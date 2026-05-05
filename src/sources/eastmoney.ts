// 东方财富适配（A 股小时/分钟，及周/月线）
// 端点：push2his.eastmoney.com/api/qt/stock/kline/get
// klt: 1=1m  5=5m  15=15m  30=30m  60=1h  101=1d  102=1wk  103=1mo
// 注意：返回 klines 字段顺序为 [date, open, close, high, low, volume, ...]（架构红线 #5 适配点）

import type { Interval, OHLCV } from '../types';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
];
function pickUA(): string {
  return UAS[Math.floor(Math.random() * UAS.length)];
}

const KLT: Record<Interval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '1d': 101,
  '1wk': 102,
  '1mo': 103,
};

/**
 * 东方财富 secid 编码：
 *   - 沪市 (sh*)、6 开头  → 1.{6 位代码}
 *   - 深市 (sz*)、其它  → 0.{6 位代码}
 *   - 北交所 (bj*)       → 0.{6 位代码}
 */
function toSecid(symbol: string): string {
  const s = symbol.toLowerCase();
  if (s.startsWith('sh')) return `1.${s.slice(2)}`;
  if (s.startsWith('sz')) return `0.${s.slice(2)}`;
  if (s.startsWith('bj')) return `0.${s.slice(2)}`;
  // 兼容裸 6 位：6 开头沪市
  return `${s.startsWith('6') ? 1 : 0}.${s}`;
}

/** 东方财富时间戳：日线 'YYYY-MM-DD'；分钟线 'YYYY-MM-DD HH:mm' */
function parseEmDate(s: string): string {
  if (s.length === 10) return new Date(`${s}T00:00:00Z`).toISOString();
  return new Date(`${s.replace(' ', 'T')}:00Z`).toISOString();
}

interface EmResp {
  data?: { klines?: string[] };
}

export async function fetchEastmoney(symbol: string, interval: Interval): Promise<OHLCV[]> {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  url.searchParams.set('secid', toSecid(symbol));
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58');
  url.searchParams.set('klt', String(KLT[interval]));
  url.searchParams.set('fqt', '1'); // 前复权
  url.searchParams.set('end', '20500101');
  // 东方财富对 lmt 限制宽松；10000 对日线 ≈ 40 年，足够拉到上市首日
  url.searchParams.set('lmt', '10000');

  const resp = await fetch(url.toString(), { headers: { 'User-Agent': pickUA() } });
  if (!resp.ok) throw new Error(`Eastmoney ${symbol} ${interval} HTTP ${resp.status}`);

  const json = (await resp.json()) as EmResp;
  const klines = json.data?.klines ?? [];

  return klines
    .map((line) => line.split(','))
    .filter((c) => c.length >= 6)
    .map<OHLCV>((c) => ({
      Datetime: parseEmDate(c[0]),
      Open: Number(c[1]),
      // 东方财富 fields2=f51..f58 顺序：date,open,close,high,low,volume,...
      Close: Number(c[2]),
      High: Number(c[3]),
      Low: Number(c[4]),
      Volume: Number(c[5]),
    }))
    .filter((r) => Number.isFinite(r.Open));
}
