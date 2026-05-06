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

// 上游 fetch 超时（毫秒），避免 push2his.eastmoney.com 偶发卡死拖死整批
const FETCH_TIMEOUT_MS = 8000;

// 5xx / 超时单次重试。push2his.eastmoney.com 经常随机 520，多 1 次 retry 能吸收 ~80% 抖动。
// 不做更多次重试：会拖长 CN 串行批次的总耗时（30s wallclock 上限）
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 400;

// lmt 行数：首抓时拉满 10000 ≈ 40 年日线；增量只取尾部最近 N 行去重合并
// 增量值故意取得比"理论上最大缺口"高几倍，给停牌/节假日留余量
const LMT_FIRST_TIME = 10000;
const LMT_INCREMENTAL: Record<Interval, number> = {
  '1m':  240,   // 半天分钟线
  '5m':  240,   // 5 天 5 分钟线
  '15m': 200,   // 1 周
  '30m': 200,   // 2 周
  '1h':  100,   // 半个月小时线
  '1d':  60,    // 2 月日线
  '1wk': 30,    // 半年周线
  '1mo': 24,    // 2 年月线
};

const INCREMENTAL_THRESHOLD_DAYS: Record<Interval, number> = {
  '1m':  1,
  '5m':  3,
  '15m': 5,
  '30m': 7,
  '1h':  10,
  '1d':  30,
  '1wk': 90,
  '1mo': 365,
};

function pickLmt(interval: Interval, dataEndAt: string | null): number {
  if (!dataEndAt) return LMT_FIRST_TIME;
  const end = Date.parse(dataEndAt);
  if (!Number.isFinite(end)) return LMT_FIRST_TIME;
  const daysSince = (Date.now() - end) / 86_400_000;
  return daysSince <= INCREMENTAL_THRESHOLD_DAYS[interval]
    ? LMT_INCREMENTAL[interval]
    : LMT_FIRST_TIME;
}

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

export async function fetchEastmoney(
  symbol: string,
  interval: Interval,
  dataEndAt: string | null = null,
): Promise<OHLCV[]> {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  url.searchParams.set('secid', toSecid(symbol));
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58');
  url.searchParams.set('klt', String(KLT[interval]));
  url.searchParams.set('fqt', '1'); // 前复权
  url.searchParams.set('end', '20500101');
  url.searchParams.set('lmt', String(pickLmt(interval, dataEndAt)));

  // 真浏览器风格的 header：东方财富对裸 fetch 偶发 520，加上 Referer/Accept 后明显改善
  const headers = {
    'User-Agent': pickUA(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://quote.eastmoney.com/',
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        // 5xx / 408 / 429 → 可重试；4xx（除上述）直接抛出，不浪费下一次 attempt
        const transient = resp.status === 408 || resp.status === 429 || resp.status >= 500;
        if (transient && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        throw new Error(`Eastmoney ${symbol} ${interval} HTTP ${resp.status}`);
      }
      const json = (await resp.json()) as EmResp;
      return parseKlines(json.data?.klines ?? []);
    } catch (err) {
      lastErr = err;
      // AbortError / 网络错 → 重试；HTTP 4xx 已在上面 throw 出来不会进这里
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`Eastmoney ${symbol} ${interval} unreachable`);
}

function parseKlines(klines: string[]): OHLCV[] {
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
