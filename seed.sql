-- =============================================================================
-- 种子标的清单（约 45 只跨市场龙头股，第一次跑通用）
-- 用法：wrangler d1 execute market_data_lake --remote --file=./seed.sql
-- 已加 INSERT OR IGNORE，重复执行不会报错
-- 想扩充到全 SP500/HSI/沪深300，从中证指数公司 / HKEX / NASDAQ Trader 下载清单批量生成 INSERT
-- =============================================================================

-- ---- US（15 只 SP500 龙头）-----------------------------------------------
INSERT OR IGNORE INTO tickers (ticker, market) VALUES
  ('AAPL',  'US'),  -- Apple
  ('MSFT',  'US'),  -- Microsoft
  ('NVDA',  'US'),  -- NVIDIA
  ('GOOGL', 'US'),  -- Alphabet
  ('META',  'US'),  -- Meta
  ('AMZN',  'US'),  -- Amazon
  ('TSLA',  'US'),  -- Tesla
  ('AMD',   'US'),  -- AMD
  ('JPM',   'US'),  -- JPMorgan Chase
  ('V',     'US'),  -- Visa
  ('WMT',   'US'),  -- Walmart
  ('JNJ',   'US'),  -- Johnson & Johnson
  ('XOM',   'US'),  -- ExxonMobil
  ('UNH',   'US'),  -- UnitedHealth
  ('NFLX',  'US');  -- Netflix

-- ---- HK（15 只 HSI 主要成分股；Yahoo 格式 = 4 位代码 + .HK）---------------
INSERT OR IGNORE INTO tickers (ticker, market) VALUES
  ('0700.HK', 'HK'),  -- 腾讯控股
  ('0941.HK', 'HK'),  -- 中国移动
  ('1299.HK', 'HK'),  -- 友邦保险
  ('0388.HK', 'HK'),  -- 港交所
  ('0939.HK', 'HK'),  -- 建设银行
  ('1398.HK', 'HK'),  -- 工商银行
  ('2318.HK', 'HK'),  -- 中国平安
  ('0005.HK', 'HK'),  -- 汇丰控股
  ('3690.HK', 'HK'),  -- 美团-W
  ('9988.HK', 'HK'),  -- 阿里巴巴-SW
  ('9618.HK', 'HK'),  -- 京东集团-SW
  ('0883.HK', 'HK'),  -- 中海油
  ('0857.HK', 'HK'),  -- 中石油
  ('1810.HK', 'HK'),  -- 小米集团-W
  ('2382.HK', 'HK');  -- 舜宇光学科技

-- ---- CN（15 只沪深主流大盘股；新浪/东方财富格式 = sh/sz + 6 位代码）-------
INSERT OR IGNORE INTO tickers (ticker, market) VALUES
  ('sh600519', 'CN'),  -- 贵州茅台
  ('sh601398', 'CN'),  -- 工商银行
  ('sh601318', 'CN'),  -- 中国平安
  ('sh600036', 'CN'),  -- 招商银行
  ('sh601988', 'CN'),  -- 中国银行
  ('sh600276', 'CN'),  -- 恒瑞医药
  ('sh600028', 'CN'),  -- 中国石化
  ('sh601857', 'CN'),  -- 中国石油
  ('sh600030', 'CN'),  -- 中信证券
  ('sh600000', 'CN'),  -- 浦发银行
  ('sz000001', 'CN'),  -- 平安银行
  ('sz000002', 'CN'),  -- 万科A
  ('sz000858', 'CN'),  -- 五粮液
  ('sz000333', 'CN'),  -- 美的集团
  ('sz002594', 'CN');  -- 比亚迪

-- ---- 默认抓取作业：所有标的的 1d -------------------------------------------
INSERT OR IGNORE INTO ticker_intervals (ticker, interval)
  SELECT ticker, '1d' FROM tickers;

-- ---- 演示多粒度：5 只龙头额外加 1h -----------------------------------------
INSERT OR IGNORE INTO ticker_intervals (ticker, interval) VALUES
  ('AAPL',     '1h'),
  ('NVDA',     '1h'),
  ('TSLA',     '1h'),
  ('0700.HK',  '1h'),
  ('sh600519', '1h');
