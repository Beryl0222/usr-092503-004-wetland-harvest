/**
 * SQLite 持久化层。
 *
 * 设计要点：
 * - 采收份额在团队到场确认时才原子落库（trip_allocations），取消/返航/释放即删除；
 * - 容量以触发器为最后防线，即使应用层漏判，数据库也会拒绝超卖；
 * - 所有状态变更写变更历史 append-only；
 * - 环境事件以 (route_id, effective_at, dedup_key) 建唯一键，迟到/重复事件据此去重并触发重算；
 * - 强制放行需两名不同授权人记录（各自填理由），由约束保证不可单人完成。
 */
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 15000;

-- 可开放地块：保育上限 = 当天同时在园团队数上限
CREATE TABLE IF NOT EXISTS plots (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  team_cap    INTEGER NOT NULL CHECK (team_cap >= 0),
  active      INTEGER NOT NULL DEFAULT 1
);

-- 火柿树：归属于地块，ripe_qty 为当日可摘果量
CREATE TABLE IF NOT EXISTS trees (
  id        TEXT PRIMARY KEY,
  plot_id   TEXT NOT NULL REFERENCES plots(id),
  ripe_qty  INTEGER NOT NULL CHECK (ripe_qty >= 0),
  active    INTEGER NOT NULL DEFAULT 1
);

-- 船只：载荷即团队席位
CREATE TABLE IF NOT EXISTS boats (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  capacity     INTEGER NOT NULL CHECK (capacity >= 0),
  -- 允许航行的最高风力等级、最低水位（米），低于/高于则不可派
  max_wind     REAL NOT NULL DEFAULT 1e9,
  min_water    REAL NOT NULL DEFAULT -1e9,
  active       INTEGER NOT NULL DEFAULT 1
);

-- 船员：资质决定可驾驶的船
CREATE TABLE IF NOT EXISTS crew_members (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS crew_boat_qualifications (
  crew_id TEXT NOT NULL REFERENCES crew_members(id),
  boat_id TEXT NOT NULL REFERENCES boats(id),
  PRIMARY KEY (crew_id, boat_id)
);

-- 航线
CREATE TABLE IF NOT EXISTS routes (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

-- 航线服务的地块（一条航线可通达多个地块）
CREATE TABLE IF NOT EXISTS route_plots (
  route_id TEXT NOT NULL REFERENCES routes(id),
  plot_id  TEXT NOT NULL REFERENCES plots(id),
  PRIMARY KEY (route_id, plot_id)
);

-- 航线时段
CREATE TABLE IF NOT EXISTS route_slots (
  id          TEXT PRIMARY KEY,
  route_id    TEXT NOT NULL REFERENCES routes(id),
  boat_id     TEXT NOT NULL REFERENCES boats(id),
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_slots_boat_time ON route_slots(boat_id, starts_at, ends_at);

-- 采收日全局参数：总采收上限（全园当天可摘果量天花板）
CREATE TABLE IF NOT EXISTS harvest_days (
  operating_day TEXT PRIMARY KEY,           -- YYYY-MM-DD
  total_cap     INTEGER NOT NULL CHECK (total_cap >= 0),
  settled       INTEGER NOT NULL DEFAULT 0, -- 日终结算后置 1
  settled_at    TEXT
);

-- 团队预约 -> 现场确认后成为行程
CREATE TABLE IF NOT EXISTS reservations (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  operating_day   TEXT NOT NULL,
  plot_id         TEXT NOT NULL REFERENCES plots(id),
  tree_id         TEXT NOT NULL REFERENCES trees(id),
  party_size      INTEGER NOT NULL CHECK (party_size > 0),
  pick_qty        INTEGER NOT NULL CHECK (pick_qty > 0),  -- 申请采摘量
  slot_id         TEXT REFERENCES route_slots(id),        -- 实际占用时段（改派会变）
  status          TEXT NOT NULL DEFAULT 'reserved',
  -- reserved 已预约(名额,不占采收份额) / confirmed 已到场原子占用 / boarded 已登船在航
  -- completed 已完成返航 / no_show 未到场释放 / cancelled 取消
  -- sheltered 避险中(已登船遇停航) / reassigned 已改派新时段
  -- force_passed 强制放行 / settled 已日终结算
  seat_expires_at TEXT NOT NULL,            -- 名额/占座截止时间
  confirmed_at    TEXT,
  boarded_at      TEXT,
  completed_at    TEXT,
  settled_at      TEXT,
  actual_pick     INTEGER NOT NULL DEFAULT 0,
  crew_id         TEXT REFERENCES crew_members(id),
  note            TEXT NOT NULL DEFAULT '',
  UNIQUE (team_id, operating_day)
);
CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(operating_day, status);
-- 一名船员同一时段只能跟一艘船
CREATE UNIQUE INDEX IF NOT EXISTS ux_res_crew_slot
  ON reservations(crew_id, slot_id) WHERE crew_id IS NOT NULL;

-- 统一占用台账：团队到场确认后原子落库，取消/返航/释放即删除
CREATE TABLE IF NOT EXISTS trip_allocations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,             -- tree_pick / plot_team / boat_seat / harvest_total
  operating_day  TEXT NOT NULL,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  resource_id    TEXT NOT NULL,             -- tree_id / plot_id / slot_id / '__day__'
  qty            INTEGER NOT NULL CHECK (qty > 0),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alloc_lookup ON trip_allocations(kind, operating_day, resource_id);

-- 船位：一个时段至多一支在航团队（确认时落，改派时先删旧再插新）
CREATE UNIQUE INDEX IF NOT EXISTS ux_slot_occupancy
  ON trip_allocations(resource_id)
  WHERE kind = 'boat_seat';

-- 容量触发器：超卖在数据库层直接失败（最后防线，应用层判据被并发击穿时生效）
CREATE TRIGGER IF NOT EXISTS trg_alloc_tree_cap
BEFORE INSERT ON trip_allocations
WHEN NEW.kind = 'tree_pick'
BEGIN
  SELECT CASE
    WHEN NEW.qty + COALESCE((
      SELECT COALESCE(SUM(qty),0) FROM trip_allocations
      WHERE kind='tree_pick' AND operating_day=NEW.operating_day AND resource_id=NEW.resource_id
    ),0) > (SELECT ripe_qty FROM trees WHERE id = NEW.resource_id)
    THEN RAISE(ABORT, 'tree capacity exceeded')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_alloc_plot_cap
BEFORE INSERT ON trip_allocations
WHEN NEW.kind = 'plot_team'
BEGIN
  SELECT CASE
    WHEN 1 + COALESCE((SELECT COUNT(*) FROM trip_allocations
      WHERE kind='plot_team' AND operating_day=NEW.operating_day AND resource_id=NEW.resource_id),0)
      > (SELECT team_cap FROM plots WHERE id = NEW.resource_id)
    THEN RAISE(ABORT, 'plot capacity exceeded')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_alloc_day_cap
BEFORE INSERT ON trip_allocations
WHEN NEW.kind = 'harvest_total'
BEGIN
  SELECT CASE
    WHEN NEW.qty + COALESCE((SELECT COALESCE(SUM(qty),0) FROM trip_allocations
      WHERE kind='harvest_total' AND operating_day=NEW.operating_day),0)
      > (SELECT total_cap FROM harvest_days WHERE operating_day = NEW.operating_day)
    THEN RAISE(ABORT, 'daily total capacity exceeded')
  END;
END;

-- 环境事件：迟到/重复以 (route_id, effective_at, dedup_key) 去重
CREATE TABLE IF NOT EXISTS env_events (
  id            TEXT PRIMARY KEY,
  route_id      TEXT NOT NULL REFERENCES routes(id),
  condition     TEXT NOT NULL CHECK (condition IN ('open','restricted','closed')),
  water_level   REAL,
  wind_level    REAL,
  effective_at  TEXT NOT NULL,            -- 有效时间（事件声称的发生时间）
  received_at   TEXT NOT NULL,            -- 系统接收时间
  dedup_key     TEXT NOT NULL,
  applied       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (route_id, effective_at, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_env_route_time ON env_events(route_id, effective_at);

-- 代金权益：取消/停航产生，幂等键保证只发一次，领取一次性
CREATE TABLE IF NOT EXISTS vouchers (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  reason         TEXT NOT NULL,           -- route_closed / ops_cancel ...
  issue_key      TEXT NOT NULL UNIQUE,    -- 幂等：reservationId + reason
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  status         TEXT NOT NULL DEFAULT 'issued', -- issued / claimed / void
  created_at     TEXT NOT NULL,
  claimed_at     TEXT,
  claimed_by     TEXT
);

-- 强制放行双重授权：两人、不同人、含理由，每团队每人至多一条
CREATE TABLE IF NOT EXISTS force_pass_approvals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  approver       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (reservation_id, approver)
);
CREATE TRIGGER IF NOT EXISTS trg_force_reason
BEFORE INSERT ON force_pass_approvals
BEGIN
  SELECT CASE WHEN length(trim(NEW.reason)) = 0
    THEN RAISE(ABORT, 'force pass requires a reason') END;
END;

-- 日终结算结果（每团队每天一行）
CREATE TABLE IF NOT EXISTS settlements (
  operating_day  TEXT NOT NULL,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  team_id        TEXT NOT NULL,
  outcome        TEXT NOT NULL,            -- completed / sheltered / force_passed / boarded_unreturned
  picked         INTEGER NOT NULL,
  settled_at     TEXT NOT NULL,
  PRIMARY KEY (operating_day, reservation_id)
);

-- 变更历史（append-only）
CREATE TABLE IF NOT EXISTS change_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  actor       TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_history_entity ON change_history(entity, entity_id);

-- 幂等键（写接口）
CREATE TABLE IF NOT EXISTS idempotency (
  idem_key    TEXT PRIMARY KEY,
  response    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- 到期作业（noshow 释放等），重启后据此继续未结流程
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,               -- release_noshow
  ref_id     TEXT NOT NULL,
  run_at     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending / done / cancelled
  finished_at TEXT,
  UNIQUE (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export function migrate(db) {
  // 先设置忙等，再执行 DDL：多连接并发打开时，WAL 切换/建表可能遇到写锁
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec(DDL);
  db.prepare("INSERT OR IGNORE INTO meta(k,v) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

export function openDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);
  migrate(db);
  return db;
}
