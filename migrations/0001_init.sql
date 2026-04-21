-- 速率计数器：每个「维度 + key + 时间窗口」一行；count 原子 +1。
-- scope: 'site_h' 全站小时 | 'ip_h' IP 小时 | 'ip_d' IP 全天
-- key:   scope='site_h' 时为 ''（全站不按 key 分）；其余为 IP 字面量。
-- window: 'YYYYMMDDHH'（小时窗）或 'YYYYMMDD'（天窗）。
CREATE TABLE IF NOT EXISTS rate_counters (
  scope  TEXT NOT NULL,
  key    TEXT NOT NULL,
  window TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, window)
);

-- 清理查询走 window 扫描
CREATE INDEX IF NOT EXISTS idx_rate_counters_window ON rate_counters (window);
