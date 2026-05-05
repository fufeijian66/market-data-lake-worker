// 批量导入各市场的标的清单
// US：NASDAQ Trader 公开 listing 文件（NASDAQ + NYSE/AMEX 大约 7000 只）
// CN：东方财富全 A 股清单接口（沪深 + 北交所 大约 5000 只）
// HK：硬编码 HSI 主要成分股清单（约 80 只；HKEX 全量列表无开放无授权 API，留待后续扩展）

import type { Market } from '../types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export interface NewTicker {
  ticker: string;
  market: Market;
}

// ---- US：NASDAQ Trader 文件 -------------------------------------------------

const US_LISTING_URLS = [
  'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
  'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
];

async function fetchUSListings(): Promise<NewTicker[]> {
  const out: NewTicker[] = [];
  const seen = new Set<string>();

  for (const url of US_LISTING_URLS) {
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error(`NASDAQ Trader ${url}: HTTP ${resp.status}`);
    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) continue;

    const headers = lines[0].split('|').map((h) => h.trim().toLowerCase());
    const symbolCol = headers.findIndex((h) => h === 'symbol' || h === 'act symbol');
    const testCol = headers.findIndex((h) => h === 'test issue');
    const etfCol = headers.findIndex((h) => h === 'etf');
    if (symbolCol < 0) continue;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith('File Creation Time')) continue;
      const cols = line.split('|');
      const sym = (cols[symbolCol] ?? '').trim();
      // 跳过优先股 / 单元 / warrant 等带特殊字符的 ticker，Yahoo 通常抓不到
      if (!sym || /[\$\.\^=]/.test(sym)) continue;
      if (testCol >= 0 && (cols[testCol] ?? '').trim() === 'Y') continue;
      if (etfCol >= 0 && (cols[etfCol] ?? '').trim() === 'Y') continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      out.push({ ticker: sym, market: 'US' });
    }
  }
  return out;
}

// ---- CN：东方财富全 A 股 ----------------------------------------------------

interface EmCnResp {
  data?: {
    total?: number;
    diff?: Array<{ f12?: string; f14?: string }>;
  };
}

async function fetchCNListings(): Promise<NewTicker[]> {
  const url = new URL('https://82.push2.eastmoney.com/api/qt/clist/get');
  url.searchParams.set('pn', '1');
  url.searchParams.set('pz', '6000');
  url.searchParams.set('po', '1');
  url.searchParams.set('np', '1');
  url.searchParams.set('fid', 'f3');
  // 沪 A + 深 A + 创业板 + 科创板 + 北交所
  url.searchParams.set('fs', 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048,m:0+t:81+s:1');
  url.searchParams.set('fields', 'f12,f14');

  const resp = await fetch(url.toString(), { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`Eastmoney listings HTTP ${resp.status}`);
  const json = (await resp.json()) as EmCnResp;
  const items = json.data?.diff ?? [];

  const out: NewTicker[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const code = String(it.f12 ?? '');
    if (!/^\d{6}$/.test(code)) continue;
    // 6/9 沪市，0/3 深市，4/8 北交所
    const prefix =
      code.startsWith('6') || code.startsWith('9') ? 'sh' : 'sz';
    const ticker = `${prefix}${code}`;
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, market: 'CN' });
  }
  return out;
}

// ---- HK：HSI 主要成分股（硬编码）-------------------------------------------

const HK_HSI_COMPONENTS = [
  '0001', '0002', '0003', '0005', '0006', '0011', '0012', '0016', '0017', '0027',
  '0066', '0101', '0175', '0241', '0267', '0288', '0291', '0316', '0322', '0386',
  '0388', '0669', '0688', '0700', '0762', '0823', '0857', '0868', '0883', '0939',
  '0941', '0960', '0968', '0981', '0992', '1038', '1044', '1093', '1099', '1109',
  '1113', '1177', '1209', '1211', '1299', '1378', '1398', '1810', '1876', '1928',
  '1929', '1997', '2007', '2015', '2018', '2020', '2269', '2313', '2318', '2319',
  '2331', '2382', '2388', '2628', '2688', '2899', '3690', '3692', '3968', '3988',
  '6098', '6862', '9618', '9633', '9888', '9961', '9988', '9999',
];

function fetchHKListings(): NewTicker[] {
  return HK_HSI_COMPONENTS.map((code) => ({
    ticker: `${code}.HK`,
    market: 'HK' as const,
  }));
}

// ---- 入口 ------------------------------------------------------------------

export async function fetchListings(market: Market): Promise<NewTicker[]> {
  if (market === 'US') return fetchUSListings();
  if (market === 'CN') return fetchCNListings();
  if (market === 'HK') return fetchHKListings();
  throw new Error(`Unsupported market: ${market}`);
}
