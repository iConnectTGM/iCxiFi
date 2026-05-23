PRAGMA journal_mode = DELETE;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS routers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  router_id TEXT NOT NULL UNIQUE,
  license_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mac TEXT,
  ip TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  remaining_seconds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  speed_profile TEXT,
  voucher_code TEXT,
  source TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sessions_mac_status ON sessions(mac, status);
CREATE INDEX IF NOT EXISTS idx_sessions_ip_status ON sessions(ip, status);
CREATE INDEX IF NOT EXISTS idx_sessions_end_time ON sessions(end_time);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  minutes INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  used_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER,
  used_at INTEGER,
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vouchers_used ON vouchers(used);

CREATE TABLE IF NOT EXISTS sales_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  device_id TEXT,
  voucher_code TEXT,
  client_mac TEXT,
  client_ip TEXT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sales_events_synced ON sales_events(synced, timestamp);

CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, created_at);
