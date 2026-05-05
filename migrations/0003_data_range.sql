-- Migration 0003：在 ticker_intervals 上记录已存数据的时间区间
-- 用法：wrangler d1 execute market_data_lake --remote --file=./migrations/0003_data_range.sql

ALTER TABLE ticker_intervals ADD COLUMN data_start_at TEXT;  -- ISO 8601，最早一根 K 线的 Datetime
ALTER TABLE ticker_intervals ADD COLUMN data_end_at   TEXT;  -- ISO 8601，最新一根 K 线的 Datetime
