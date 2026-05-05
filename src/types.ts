// 全局共用类型定义

export type Market = 'US' | 'HK' | 'CN';

export type Interval = '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1wk' | '1mo';

// CSV 一行 / 抓取层归一化后的 OHLCV bar
export interface OHLCV {
  Datetime: string; // ISO 8601 UTC，如 '2026-05-05T00:00:00Z' 或 '2026-05-05T14:00:00Z'
  Open: number;
  High: number;
  Low: number;
  Close: number;
  Volume: number;
}

// Worker env 绑定（与 wrangler.jsonc 的 vars / D1 binding 对齐）
export interface Env {
  market_data_lake: D1Database;

  // S3（公开 vars）
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  // S3 凭证（必须 secret，不要写进 vars）
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;

  // Cloudflare Access
  ACCESS_TEAM_DOMAIN: string; // 形如 'yourteam.cloudflareaccess.com'
  ACCESS_AUD: string;         // Access Application 的 Audience Tag

  // 'development' 时 access-auth 中间件会跳过校验（用于 wrangler dev）
  ENVIRONMENT?: string;
}

// D1 中 ticker_intervals 一行
export interface JobRow {
  ticker: string;
  interval: Interval;
  is_active: number;        // D1 没有 boolean，用 0/1
  last_updated_at: number;  // Unix epoch ms
  error_flag: number;
  error_message: string | null;
  error_count: number;
  row_count: number;        // S3 中已存的 K 线条数
}

// 调度阶段把 tickers.market / tickers.name join 进来
export interface TickerJob extends JobRow {
  market: Market;
  name: string | null;
}
