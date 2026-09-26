import { DatabaseSync } from "node:sqlite";

/**
 * 打开（必要时创建）调度库。
 * - WAL + busy_timeout：允许闸机/运营端多连接、多线程并发写入，
 *   写事务由 SQLite 文件锁串行化，配合 BEGIN IMMEDIATE 与应用层重试杜绝超卖。
 * - 所有结构带 IF NOT EXISTS，重启后重复打开安全。
 */
export function openDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=10000");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(SCHEMA);
  db.exec(
    `INSERT OR IGNORE INTO meta(meta_key,value) VALUES
      ('schema_version','1'),
      ('price_per_kg','20'),
      ('voucher_per_kg','10'),
      ('grace_minutes','20'),
      ('currency','CNY')`
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  meta_key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 地块：保育上限（千克/日） ------------------------------------------------
CREATE TABLE IF NOT EXISTS plots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  daily_cap_kg INTEGER NOT NULL CHECK (daily_cap_kg >= 0),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS trees (
  id TEXT PRIMARY KEY,
  plot_id TEXT NOT NULL REFERENCES plots(id),
  name TEXT NOT NULL
);

-- 树木当日可摘果量（成熟度），按日生效，可逐日录入 --------------------------
CREATE TABLE IF NOT EXISTS tree_capacity (
  tree_id TEXT NOT NULL REFERENCES trees(id),
  cap_date TEXT NOT NULL,
  available_kg INTEGER NOT NULL CHECK (available_kg >= 0),
  PRIMARY KEY (tree_id, cap_date)
);

CREATE TABLE IF NOT EXISTS boats (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload_kg INTEGER NOT NULL CHECK (payload_kg >= 0)
);

CREATE TABLE IF NOT EXISTS crew_members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  certs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- 航次：某日某航线的一个时段 + 值班船 + 名额上限 + 所需资质 ------------------
CREATE TABLE IF NOT EXISTS sailings (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  boat_id TEXT NOT NULL REFERENCES boats(id),
  cap_date TEXT NOT NULL,
  depart_at TEXT NOT NULL,
  arrive_at TEXT NOT NULL,
  team_capacity INTEGER NOT NULL CHECK (team_capacity >= 0),
  required_certs_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','restricted','closed')),
  closed_event_key TEXT,
  CHECK (arrive_at > depart_at)
);
CREATE INDEX IF NOT EXISTS idx_sailings_route ON sailings(route_id, cap_date);

CREATE TABLE IF NOT EXISTS crew_assignments (
  sailing_id TEXT NOT NULL REFERENCES sailings(id),
  crew_id TEXT NOT NULL REFERENCES crew_members(id),
  PRIMARY KEY (sailing_id, crew_id)
);

-- 航线可服务的树木（决定航次能采哪些树、改派候选航次） ---------------------
CREATE TABLE IF NOT EXISTS route_trees (
  route_id TEXT NOT NULL REFERENCES routes(id),
  tree_id TEXT NOT NULL REFERENCES trees(id),
  PRIMARY KEY (route_id, tree_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  demand_kg INTEGER NOT NULL CHECK (demand_kg >= 0)
);

-- 预约/名额 ----------------------------------------------------------------
-- kind='guaranteed' 预约即预占全部采收份额；kind='waitlist' 候补不占资源，
-- 到场时与现场团队一起原子抢占（释放出的）份额。
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  sailing_id TEXT NOT NULL REFERENCES sailings(id),
  cap_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('guaranteed','waitlist')),
  status TEXT NOT NULL CHECK (status IN (
    'reserved','waitlisted','confirmed','reassigned','boarded',
    'sheltering','completed','settled','event_canceled','expired',
    'no_show_canceled'
  )),
  kg_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (kg_confirmed >= 0),
  kg_harvested INTEGER NOT NULL DEFAULT 0 CHECK (kg_harvested >= 0),
  deadline TEXT NOT NULL,
  reserved_shares_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  boarded_at TEXT,
  completed_at TEXT,
  canceled_at TEXT,
  expired_at TEXT,
  settled_at TEXT,
  canceled_event_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_sailing ON bookings(sailing_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(cap_date, status);

-- 统一资源占用（份额）。active=1 计入容量；释放时置 0 并保留原因与时间。
-- resource_type: tree（树，按日千克）/ plot（地块，按日千克）/
--                boat（船，scope_ref=航次，千克）/ slot（队伍名额，scope_ref=航次，个数记为 kg=1）
CREATE TABLE IF NOT EXISTS occupancy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  cap_date TEXT NOT NULL,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('tree','plot','boat','slot')),
  resource_id TEXT NOT NULL,
  scope_ref TEXT,
  kg INTEGER NOT NULL CHECK (kg >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_occ_lookup
  ON occupancy(resource_type, resource_id, scope_ref, cap_date, active);
-- 同一名额对同一资源有且仅有一条生效占用：重复到场/重复扣减在数据库层失败。
CREATE UNIQUE INDEX IF NOT EXISTS uq_occ_active
  ON occupancy(booking_id, resource_type, resource_id, COALESCE(scope_ref,''), cap_date)
  WHERE active = 1;

-- 行程（改派生成新版本，历史保留） ------------------------------------------
CREATE TABLE IF NOT EXISTS itineraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  version INTEGER NOT NULL,
  sailing_id TEXT NOT NULL REFERENCES sailings(id),
  shares_json TEXT NOT NULL,
  crew_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (booking_id, version)
);

-- 名额状态时间线：迟到的监测事件据此按"事件生效时刻的真实状态"分流 -----------
CREATE TABLE IF NOT EXISTS booking_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  at TEXT NOT NULL,
  reason TEXT NOT NULL,
  event_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_timeline_booking ON booking_timeline(booking_id, at);

-- 环境监测事件（event_key 幂等去重，迟到/重复均安全） -----------------------
CREATE TABLE IF NOT EXISTS env_events (
  event_key TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  cond TEXT NOT NULL CHECK (cond IN ('open','restricted','closed')),
  effective_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  processed_at TEXT
);

-- 每个事件对每个名额只产生一次动作（reassigned/sheltered/canceled/settled） --
CREATE TABLE IF NOT EXISTS event_effects (
  event_key TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL,
  PRIMARY KEY (event_key, booking_id, action)
);

CREATE TABLE IF NOT EXISTS reassignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  event_key TEXT NOT NULL,
  from_sailing_id TEXT NOT NULL,
  to_sailing_id TEXT NOT NULL,
  demand_kg INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 代金权益：(名额,事件) 唯一 → 同一事件补偿只发一次 --------------------------
CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  event_key TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','claimed')),
  issued_at TEXT NOT NULL,
  claimed_at TEXT,
  claim_key TEXT,
  UNIQUE (booking_id, event_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voucher_claim_key
  ON vouchers(claim_key) WHERE claim_key IS NOT NULL;

-- 日终结算单：每个名额至多一张 ---------------------------------------------
CREATE TABLE IF NOT EXISTS settlements (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
  cap_date TEXT NOT NULL,
  kg INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 人工强制放行：双重授权（两个不同的授权人工号）+ 必填理由 -------------------
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  authorizer_a TEXT NOT NULL,
  authorizer_b TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (authorizer_a <> authorizer_b),
  CHECK (length(trim(reason)) > 0)
);

-- 全部资源占用与状态变更的审计日志 ------------------------------------------
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  operator TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_entity ON change_log(entity, entity_id);
`;
