-- Migration 0002：为已存在的库添加 name 与 row_count
-- 新建库直接跑 schema.sql 即可，会带上这两列；本文件只给老库用。
-- 用法：wrangler d1 execute market_data_lake --remote --file=./migrations/0002_names_and_rowcount.sql

ALTER TABLE tickers          ADD COLUMN name      TEXT;
ALTER TABLE ticker_intervals ADD COLUMN row_count INTEGER NOT NULL DEFAULT 0;
