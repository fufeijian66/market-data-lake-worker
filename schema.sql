-- =============================================================================
-- market-data-lake-worker —— D1 schema
-- 双表设计：tickers（标的主表）+ ticker_intervals（抓取作业表）
-- 多粒度（1m/5m/15m/30m/1h/1d/1wk/1mo）通过 ticker_intervals 行驱动，零代码扩展
-- =============================================================================

-- 标的主表：每只标的一行
CREATE TABLE IF NOT EXISTS tickers (
  ticker  TEXT PRIMARY KEY,
  market  TEXT NOT NULL CHECK (market IN ('US', 'HK', 'CN')),
  name    TEXT                                            -- 标的中/英文名称（来自数据源）
);

-- 抓取作业表：每个 (ticker, interval) 组合一行；is_active 在作业层 → 可单独暂停某粒度
CREATE TABLE IF NOT EXISTS ticker_intervals (
  ticker          TEXT    NOT NULL,
  interval        TEXT    NOT NULL CHECK (interval IN ('1m','5m','15m','30m','1h','1d','1wk','1mo')),
  is_active       INTEGER NOT NULL DEFAULT 1,            -- 1=启用 / 0=暂停
  last_updated_at INTEGER NOT NULL DEFAULT 0,            -- Unix epoch ms；0 表示从未抓过（优先调度）
  error_flag      INTEGER NOT NULL DEFAULT 0,            -- 1=最近一次抓取失败
  error_message   TEXT,                                  -- 最近一次失败的错误信息（截断 500 字）
  error_count     INTEGER NOT NULL DEFAULT 0,            -- 累计失败次数；retry 时清零
  row_count       INTEGER NOT NULL DEFAULT 0,            -- S3 中已存的 K 线条数（每次合并写入后回写）
  data_start_at   TEXT,                                  -- ISO 8601，最早一根 K 线的 Datetime
  data_end_at     TEXT,                                  -- ISO 8601，最新一根 K 线的 Datetime
  PRIMARY KEY (ticker, interval),
  FOREIGN KEY (ticker) REFERENCES tickers(ticker) ON DELETE CASCADE
);

-- 调度核心索引：先 is_active 过滤、再 last_updated_at 升序取 20
CREATE INDEX IF NOT EXISTS idx_jobs_active_oldest
  ON ticker_intervals (is_active, last_updated_at);

-- 后台筛选用：按市场 + 状态过滤
CREATE INDEX IF NOT EXISTS idx_tickers_market ON tickers (market);

-- 系统级配置（kv 表，存运行时开关；cron schedule 由 wrangler.jsonc 决定，这里仅用于展示）
CREATE TABLE IF NOT EXISTS system_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 默认值：cron 默认开启，schedule 仅用于 UI 展示（真值在 wrangler.jsonc）
INSERT OR IGNORE INTO system_config (key, value) VALUES
  ('cron_enabled',  '1'),
  ('cron_schedule', '*/2 * * * *');

-- =============================================================================
-- 示例种子数据（按需取消注释执行）
-- =============================================================================

-- INSERT INTO tickers (ticker, market) VALUES
--   ('AAPL',     'US'),
--   ('MSFT',     'US'),
--   ('0700.HK',  'HK'),
--   ('sh600519', 'CN');

-- INSERT INTO ticker_intervals (ticker, interval) VALUES
--   ('AAPL',     '1d'),
--   ('AAPL',     '1h'),    -- 同一只股票可同时抓多个粒度
--   ('MSFT',     '1d'),
--   ('0700.HK',  '1d'),
--   ('sh600519', '1d');
