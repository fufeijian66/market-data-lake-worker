// 批量导入各市场的标的清单（含中英文名称）
// US：NASDAQ Trader 公开 listing 文件（NASDAQ + NYSE/AMEX 大约 7000 只）
// CN：东方财富全 A 股清单接口（沪深 + 北交所 大约 5000 只）
// HK：硬编码 HSI 主要成分股清单（约 80 只；HKEX 全量列表无开放无授权 API）

import type { Market } from '../types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export interface NewTicker {
  ticker: string;
  market: Market;
  name: string;
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
    const nameCol = headers.findIndex((h) => h === 'security name');
    const testCol = headers.findIndex((h) => h === 'test issue');
    const etfCol = headers.findIndex((h) => h === 'etf');
    if (symbolCol < 0) continue;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith('File Creation Time')) continue;
      const cols = line.split('|');
      const sym = (cols[symbolCol] ?? '').trim();
      if (!sym || /[\$\.\^=]/.test(sym)) continue;
      if (testCol >= 0 && (cols[testCol] ?? '').trim() === 'Y') continue;
      if (etfCol >= 0 && (cols[etfCol] ?? '').trim() === 'Y') continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      // Security Name 形如 "Apple Inc. - Common Stock"，按 " - " 切掉证券类型后缀
      const rawName = nameCol >= 0 ? (cols[nameCol] ?? '').trim() : '';
      const name = rawName.replace(/\s+-\s+(Common|Preferred|Ordinary|Class|Depositary|ADR)[\s\S]*$/i, '');
      out.push({ ticker: sym, market: 'US', name });
    }
  }
  return out;
}

// ---- CN：东方财富全 A 股 ----------------------------------------------------

interface EmCnResp {
  data?: {
    total?: number;
    diff?: Array<{ f12?: string; f13?: number; f14?: string }>;
  };
}

const CN_LISTING_PAGE_SIZE = 100;

function buildCNListingUrl(page: number): URL {
  const url = new URL('https://82.push2.eastmoney.com/api/qt/clist/get');
  url.searchParams.set('pn', String(page));
  // 东方财富现在会把 pz > 100 静默截到 100；必须逐页拉完整列表。
  url.searchParams.set('pz', String(CN_LISTING_PAGE_SIZE));
  url.searchParams.set('po', '1');
  url.searchParams.set('np', '1');
  // 用代码排序保持分页稳定；按涨跌幅 f3 排序时盘中翻页会重复/漏项。
  url.searchParams.set('fid', 'f12');
  url.searchParams.set('fs', 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048,m:0+t:81+s:1');
  url.searchParams.set('fields', 'f12,f13,f14');
  return url;
}

function toCnTicker(code: string, marketId: number | undefined): string {
  if (marketId === 1) return `sh${code}`;
  if (/^[489]/.test(code)) return `bj${code}`;
  return `sz${code}`;
}

async function fetchCNListings(): Promise<NewTicker[]> {
  const out: NewTicker[] = [];
  const seen = new Set<string>();
  let total: number | null = null;

  for (let page = 1; ; page++) {
    const resp = await fetch(buildCNListingUrl(page).toString(), { headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error(`Eastmoney listings page=${page} HTTP ${resp.status}`);
    const json = (await resp.json()) as EmCnResp;
    const items = json.data?.diff ?? [];
    if (typeof json.data?.total === 'number') total = json.data.total;

    for (const it of items) {
      const code = String(it.f12 ?? '');
      if (!/^\d{6}$/.test(code)) continue;
      const ticker = toCnTicker(code, it.f13);
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({ ticker, market: 'CN', name: String(it.f14 ?? '') });
    }

    const fetchedRows = (page - 1) * CN_LISTING_PAGE_SIZE + items.length;
    if (items.length === 0 || (total != null && fetchedRows >= total)) break;
  }
  return out;
}

// ---- HK：HSI 主要成分股（硬编码：code → name）-----------------------------

const HK_HSI_NAMES: Record<string, string> = {
  '0001': '长和',                  '0002': '中电控股',              '0003': '香港中华煤气',
  '0005': '汇丰控股',              '0006': '电能实业',              '0011': '恒生银行',
  '0012': '恒基地产',              '0016': '新鸿基地产',            '0017': '新世界发展',
  '0027': '银河娱乐',              '0066': '港铁公司',              '0101': '恒隆地产',
  '0175': '吉利汽车',              '0241': '阿里健康',              '0267': '中信股份',
  '0288': '万洲国际',              '0291': '华润啤酒',              '0316': '东方海外国际',
  '0322': '康师傅控股',            '0386': '中国石油化工股份',      '0388': '香港交易所',
  '0669': '创科实业',              '0688': '中国海外发展',          '0700': '腾讯控股',
  '0762': '中国联通',              '0823': '领展房产基金',          '0857': '中国石油股份',
  '0868': '信义玻璃',              '0883': '中国海洋石油',          '0939': '建设银行',
  '0941': '中国移动',              '0960': '龙湖集团',              '0968': '信义光能',
  '0981': '中芯国际',              '0992': '联想集团',              '1038': '长江基建集团',
  '1044': '恒安国际',              '1093': '石药集团',              '1099': '国药控股',
  '1109': '华润置地',              '1113': '长实集团',              '1177': '中国生物制药',
  '1209': '华润万象生活',          '1211': '比亚迪股份',            '1299': '友邦保险',
  '1378': '中国宏桥',              '1398': '工商银行',              '1810': '小米集团-W',
  '1876': '百威亚太',              '1928': '金沙中国有限公司',      '1929': '周大福',
  '1997': '九龙仓置业',            '2007': '碧桂园',                '2015': '理想汽车-W',
  '2018': '瑞声科技',              '2020': '安踏体育',              '2269': '药明生物',
  '2313': '申洲国际',              '2318': '中国平安',              '2319': '蒙牛乳业',
  '2331': '李宁',                  '2382': '舜宇光学科技',          '2388': '中银香港',
  '2628': '中国人寿',              '2688': '新奥能源',              '2899': '紫金矿业',
  '3690': '美团-W',                '3692': '翰森制药',              '3968': '招商银行',
  '3988': '中国银行',              '6098': '碧桂园服务',            '6862': '海底捞',
  '9618': '京东集团-SW',           '9633': '农夫山泉',              '9888': '百度集团-SW',
  '9961': '携程集团-S',            '9988': '阿里巴巴-SW',           '9999': '网易-S',
};

function fetchHKListings(): NewTicker[] {
  return Object.keys(HK_HSI_NAMES).map((code) => ({
    ticker: `${code}.HK`,
    market: 'HK' as const,
    name: HK_HSI_NAMES[code],
  }));
}

// ---- 入口 ------------------------------------------------------------------

export async function fetchListings(market: Market): Promise<NewTicker[]> {
  if (market === 'US') return fetchUSListings();
  if (market === 'CN') return fetchCNListings();
  if (market === 'HK') return fetchHKListings();
  throw new Error(`Unsupported market: ${market}`);
}
