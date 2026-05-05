// 新浪财经适配（A 股日线）
// 端点：money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData
// scale 单位是分钟数：5/15/30/60/240（240≈一日交易分钟数 → 日线）

import type { Interval, OHLCV } from '../types';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
];
function pickUA(): string {
  return UAS[Math.floor(Math.random() * UAS.length)];
}

const SCALE: Partial<Record<Interval, number>> = {
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '1d': 240,
};

interface SinaRow {
  day: string;          // 日线: 'YYYY-MM-DD'  分钟线: 'YYYY-MM-DD HH:mm:ss'
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
  amount?: string;
}

/** 新浪 day 字段统一转 ISO 8601 UTC（架构红线 #5） */
function parseSinaDate(day: string): string {
  if (day.length === 10) return new Date(`${day}T00:00:00Z`).toISOString();
  return new Date(`${day.replace(' ', 'T')}Z`).toISOString();
}

export async function fetchSina(symbol: string, interval: Interval): Promise<OHLCV[]> {
  const scale = SCALE[interval];
  if (scale == null) throw new Error(`Sina 不支持 interval=${interval}`);

  const url = new URL(
    'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData',
  );
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('scale', String(scale));
  url.searchParams.set('ma', 'no');
  url.searchParams.set('datalen', '1023');

  const resp = await fetch(url.toString(), { headers: { 'User-Agent': pickUA() } });
  if (!resp.ok) throw new Error(`Sina ${symbol} ${interval} HTTP ${resp.status}`);

  // 新浪偶尔返回 JSONP 包装；先尝试纯 JSON，失败再剥包装
  const text = await resp.text();
  let arr: SinaRow[];
  try {
    arr = JSON.parse(text) as SinaRow[];
  } catch {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`Sina ${symbol} ${interval}: cannot parse response`);
    arr = JSON.parse(m[0]) as SinaRow[];
  }

  return arr
    .map<OHLCV>((row) => ({
      Datetime: parseSinaDate(row.day),
      Open: Number(row.open),
      High: Number(row.high),
      Low: Number(row.low),
      Close: Number(row.close),
      Volume: Number(row.volume ?? row.amount ?? 0),
    }))
    .filter((r) => Number.isFinite(r.Open));
}
