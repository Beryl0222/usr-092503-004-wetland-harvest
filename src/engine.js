/**
 * 采收调度引擎。
 *
 * 并发与一致性：
 * - 所有多步占用变更包在 BEGIN IMMEDIATE 事务里，SQLite 写锁串行化并发到场；
 * - 容量触发器是最后防线，应用层判断被并发击穿时数据库直接 ABORT；
 * - 环境事件按“有效时间”重算，动作全部以当前状态为闸（幂等），重复/乱序事件结果稳定；
 * - 代金权益以 issue_key 去重（只发一次），领取为单行状态翻转（只领一次）；
 * - 强制放行需两名不同授权人且各自填写理由，两人齐备才执行越权确认。
 *
 * 时钟可注入：clock.nowMs() / clock.iso()，日终结算与到期释放均以注入时间为准。
 */
import { randomUUID } from "node:crypto";
import { openDatabase } from "./db.js";

export const Status = Object.freeze({
  RESERVED: "reserved",
  CONFIRMED: "confirmed",
  BOARDED: "boarded",
  COMPLETED: "completed",
  NO_SHOW: "no_show",
  CANCELLED: "cancelled",
  SHELTERED: "sheltered",
  REASSIGNED: "reassigned",
  REROUTE_PENDING: "reroute_pending",
  FORCE_PASSED: "force_passed",
  SETTLED: "settled"
});

const ACTIVE = ["reserved", "confirmed", "boarded", "reassigned", "reroute_pending", "sheltered", "force_passed"];
const ON_WATER = ["boarded", "sheltered", "force_passed"];
// 尚未登船、可能因停航改派的状态
const NOT_BOARDED = ["reserved", "confirmed", "reassigned", "reroute_pending"];

export class Clock {
  nowMs() { return Date.now(); }
  iso() { return new Date(this.nowMs()).toISOString(); }
  day(ms = this.nowMs()) { return new Date(ms).toISOString().slice(0, 10); }
}

export class FakeClock extends Clock {
  constructor(initialIso) {
    super();
    this.t = Date.parse(initialIso);
  }
  nowMs() { return this.t; }
  advance(ms) { this.t += ms; return this; }
  setTo(iso) { this.t = Date.parse(iso); return this; }
}

export class CapacityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class SchedulingEngine {
  /**
   * @param {object} opts
   * @param {string} [opts.path] SQLite 文件路径，默认内存库
   * @param {Clock}  [opts.clock] 可注入时钟
   * @param {number} [opts.confirmGraceMs] 到场确认后须登船的宽限
   * @param {number} [opts.closeVoucherCents] 停航取消的默认代金（分）
   */
  constructor(opts = {}) {
    this.db = opts.db ?? openDatabase(opts.path ?? ":memory:");
    this.clock = opts.clock ?? new Clock();
    this.confirmGraceMs = opts.confirmGraceMs ?? 30 * 60 * 1000;
    this.closeVoucherCents = opts.closeVoucherCents ?? 5000;
    this._stmtCache = new Map();
  }

  // ---------- 基础工具 ----------

  #sql(key, sql) {
    let s = this._stmtCache.get(key);
    if (!s) { s = this.db.prepare(sql); this._stmtCache.set(key, s); }
    return s;
  }

  #tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  #history(entity, entityId, action, detail = {}, actor = "system") {
    this.#sql("hist", `INSERT INTO change_history(at,entity,entity_id,action,detail,actor)
      VALUES (?,?,?,?,?,?)`)
      .run(this.clock.iso(), entity, entityId, action, JSON.stringify(detail), actor);
  }

  // ---------- 资源建档（管理端播种） ----------

  seed(data = {}) {
    return this.#tx(() => {
      const out = { plots: [], trees: [], boats: [], crew: [], routes: [], slots: [], days: [] };
      for (const p of data.plots ?? []) {
        this.#sql("p", `INSERT INTO plots(id,name,team_cap,active) VALUES (?,?,?,1)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, team_cap=excluded.team_cap`)
          .run(p.id, p.name, p.teamCap);
        out.plots.push(p.id);
      }
      for (const t of data.trees ?? []) {
        this.#sql("t", `INSERT INTO trees(id,plot_id,ripe_qty,active) VALUES (?,?,?,1)
          ON CONFLICT(id) DO UPDATE SET ripe_qty=excluded.ripe_qty`)
          .run(t.id, t.plotId, t.ripeQty);
        out.trees.push(t.id);
      }
      for (const b of data.boats ?? []) {
        this.#sql("b", `INSERT INTO boats(id,name,capacity,max_wind,min_water,active)
          VALUES (?,?,?,?,?,1)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, capacity=excluded.capacity,
            max_wind=excluded.max_wind, min_water=excluded.min_water`)
          .run(b.id, b.name, b.capacity, b.maxWind ?? 1e9, b.minWater ?? -1e9);
        out.boats.push(b.id);
      }
      for (const c of data.crew ?? []) {
        this.db.prepare(`INSERT INTO crew_members(id,name,active) VALUES (?,?,1)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run(c.id, c.name);
        for (const boatId of c.boatIds ?? []) {
          this.db.prepare(`INSERT OR IGNORE INTO crew_boat_qualifications(crew_id,boat_id) VALUES (?,?)`)
            .run(c.id, boatId);
        }
        out.crew.push(c.id);
      }
      for (const r of data.routes ?? []) {
        this.db.prepare(`INSERT INTO routes(id,name,active) VALUES (?,?,1)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run(r.id, r.name);
        for (const plotId of r.plotIds ?? []) {
          this.db.prepare(`INSERT OR IGNORE INTO route_plots(route_id,plot_id) VALUES (?,?)`)
            .run(r.id, plotId);
        }
        out.routes.push(r.id);
      }
      for (const s of data.slots ?? []) {
        this.db.prepare(`INSERT INTO route_slots(id,route_id,boat_id,starts_at,ends_at)
          VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET boat_id=excluded.boat_id,
            starts_at=excluded.starts_at, ends_at=excluded.ends_at`)
          .run(s.id, s.routeId, s.boatId, s.startsAt, s.endsAt);
        out.slots.push(s.id);
      }
      for (const d of data.days ?? []) {
        this.db.prepare(`INSERT INTO harvest_days(operating_day,total_cap) VALUES (?,?)
          ON CONFLICT(operating_day) DO UPDATE SET total_cap=excluded.total_cap`)
          .run(d.operatingDay, d.totalCap);
        out.days.push(d.operatingDay);
      }
      this.#history("catalog", "*", "seed", { counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])) });
      return out;
    });
  }

  // ---------- 查询辅助 ----------

  #getReservation(id) {
    return this.db.prepare(`SELECT * FROM reservations WHERE id = ?`).get(id);
  }

  #slotInfo(slotId) {
    return this.db.prepare(`SELECT s.*, r.id AS route_id FROM route_slots s
      JOIN routes r ON r.id = s.route_id WHERE s.id = ?`).get(slotId);
  }

  /** 某航线在给定时刻的最新环境状态（按有效时间）。 */
  routeStateAt(routeId, atIso) {
    const row = this.db.prepare(`SELECT * FROM env_events
      WHERE route_id = ? AND effective_at <= ?
      ORDER BY effective_at DESC, received_at DESC, id DESC LIMIT 1`).get(routeId, atIso);
    return row ? { condition: row.condition, waterLevel: row.water_level, windLevel: row.wind_level, at: row.effective_at }
      : { condition: "open", waterLevel: null, windLevel: null, at: null };
  }

  /** 船只能否耐受某状态：closed 一律不可；restricted 看水位/风力阈值。 */
  static #tolerates(boat, state) {
    if (state.condition === "closed") return false;
    if (state.condition === "restricted") {
      if (state.windLevel != null && state.windLevel > boat.max_wind) return false;
      if (state.waterLevel != null && state.waterLevel < boat.min_water) return false;
    }
    return true;
  }

  /**
   * 时段是否可航：先看时段开始时刻的持续状态（开始前的 closed/restricted 会延续进来），
   * 再看时段内的每个事件片段；任一片段 closed 或超船的耐受阈值即不可航。
   * 确定性规则，重复/迟到事件只会得到同一份片段集合。
   */
  #slotFeasible(slot, boat, fromIso = null) {
    if (!fromIso) {
      const startState = this.routeStateAt(slot.route_id, slot.starts_at);
      if (!SchedulingEngine.#tolerates(boat, startState)) return false;
    }
    const events = this.db.prepare(`SELECT * FROM env_events
      WHERE route_id = ? AND effective_at < ? AND effective_at >= ?
      ORDER BY effective_at, received_at, id`).all(slot.route_id, slot.ends_at, fromIso ?? slot.starts_at);
    for (const ev of events) {
      if (!SchedulingEngine.#tolerates(boat, ev)) return false;
    }
    return true;
  }

  #pickCrew(boatId, slotId) {
    return this.db.prepare(`SELECT c.id FROM crew_members c
      JOIN crew_boat_qualifications q ON q.crew_id = c.id
      WHERE q.boat_id = ? AND c.active = 1
        AND c.id NOT IN (
          SELECT crew_id FROM reservations WHERE slot_id = ?
            AND status IN ('confirmed','boarded','reassigned','sheltered','force_passed'))
      ORDER BY c.id LIMIT 1`).get(boatId, slotId)?.id ?? null;
  }

  // ---------- 预约（占名额） ----------

  createReservation(input) {
    return this.#tx(() => {
      const tree = this.db.prepare(`SELECT t.*, p.team_cap FROM trees t
        JOIN plots p ON p.id = t.plot_id WHERE t.id = ? AND t.active = 1`).get(input.treeId);
      if (!tree) throw new CapacityError("NOT_FOUND", "树木不存在或已停用");
      const slot = this.#slotInfo(input.slotId);
      if (!slot) throw new CapacityError("NOT_FOUND", "航线时段不存在");
      const serves = this.db.prepare(`SELECT 1 FROM route_plots WHERE route_id=? AND plot_id=?`)
        .get(slot.route_id, tree.plot_id);
      if (!serves) throw new CapacityError("BAD_ROUTE", "该时段航线不服务此地块");
      const boat = this.db.prepare(`SELECT * FROM boats WHERE id=? AND active=1`).get(slot.boat_id);
      if (input.partySize > boat.capacity) throw new CapacityError("BOAT_FULL", "团队人数超过船只载荷");
      if (input.pickQty > tree.ripe_qty) throw new CapacityError("TREE_CAPACITY", "申请量超过当日可摘果量");
      const day = slot.starts_at.slice(0, 10);
      const dayRow = this.db.prepare(`SELECT * FROM harvest_days WHERE operating_day=?`).get(day);
      if (!dayRow) throw new CapacityError("NO_DAY", "该采收日未开放");
      if (dayRow.settled) throw new CapacityError("DAY_SETTLED", "该日已结算");

      // 预约是可释放名额，不占采收份额；仅对“已确认占用”做软预检给出早信号，
      // 真正的原子容量判定发生在到场确认（数据库触发器兜底）。
      this.#precheckCapacity(tree, dayRow, slot, input);

      const id = input.id ?? `R-${randomUUID()}`;
      this.db.prepare(`INSERT INTO reservations
        (id,team_id,operating_day,plot_id,tree_id,party_size,pick_qty,slot_id,status,seat_expires_at)
        VALUES (?,?,?,?,?,?,?,?,'reserved',?)`)
        .run(id, input.teamId, day, tree.plot_id, tree.id, input.partySize, input.pickQty, slot.id, slot.starts_at);
      this.#addJob("release_noshow", id, slot.starts_at);
      this.#history("reservation", id, "reserve", { teamId: input.teamId, slotId: slot.id, pickQty: input.pickQty });
      return this.#getReservation(id);
    });
  }

  /** 针对已确认占用的软预检：让明显超卖的预约尽早失败（非最终保证，确认时仍原子判定）。 */
  #precheckCapacity(tree, dayRow, slot, input) {
    const treeUsed = this.db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM trip_allocations
      WHERE kind='tree_pick' AND operating_day=? AND resource_id=?`).get(dayRow.operating_day, tree.id).q;
    if (treeUsed + input.pickQty > tree.ripe_qty) {
      throw new CapacityError("TREE_CAPACITY", "该树可摘份额已被到场团队占满");
    }
    const plotUsed = this.db.prepare(`SELECT COUNT(*) n FROM trip_allocations
      WHERE kind='plot_team' AND operating_day=? AND resource_id=?`).get(dayRow.operating_day, tree.plot_id).n;
    if (plotUsed + 1 > tree.team_cap) throw new CapacityError("CAPACITY", "地块保育团队数已达上限");
    const dayUsed = this.db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM trip_allocations
      WHERE kind='harvest_total' AND operating_day=?`).get(dayRow.operating_day).q;
    if (dayUsed + input.pickQty > dayRow.total_cap) {
      throw new CapacityError("CAPACITY", "当日总采收上限已被到场团队占满");
    }
    const slotTaken = this.db.prepare(`SELECT 1 FROM trip_allocations
      WHERE kind='boat_seat' AND resource_id=?`).get(slot.id);
    if (slotTaken) throw new CapacityError("BOAT_FULL", "该时段船位已被到场团队占用");
    const crew = this.db.prepare(`SELECT 1 FROM crew_boat_qualifications q
      JOIN crew_members c ON c.id=q.crew_id WHERE q.boat_id=? AND c.active=1`).get(slot.boat_id);
    if (!crew) throw new CapacityError("NO_CREW", "没有具备该船资质的船员");
  }

  #addJob(kind, refId, runAt) {
    this.db.prepare(`INSERT OR IGNORE INTO jobs(kind,ref_id,run_at) VALUES (?,?,?)`).run(kind, refId, runAt);
  }

  #mapCapacity(e, fallback) {
    if (String(e?.message ?? "").includes("capacity") || String(e?.message ?? "").includes("UNIQUE")) {
      return new CapacityError("CAPACITY", `${fallback}: ${e.message}`);
    }
    return e;
  }

  // ---------- 到场确认：原子占用 ----------

  /**
   * 团队到场确认。并发调用由 BEGIN IMMEDIATE 串行化，
   * tree/plot/day/boat_slot/crew 五类占用在同一事务内落库，触发器兜底防超卖。
   */
  confirmArrival(reservationId, opts = {}) {
    return this.#tx(() => this.#confirmArrivalInner(reservationId, opts));
  }

  #confirmArrivalInner(reservationId, opts = {}) {
    const nowIso = this.clock.iso();
    const nowMs = this.clock.nowMs();
    const r = this.#getReservation(reservationId);
    if (!r) throw new CapacityError("NOT_FOUND", "预约不存在");
    // reserved 或“改派时尚未确认”（无船员/无占用）的团队可到场确认
    const canConfirm = r.status === Status.RESERVED
      || (r.status === Status.REASSIGNED && r.crew_id == null);
    if (!canConfirm) throw new CapacityError("BAD_STATE", `当前状态 ${r.status} 不可确认`);
    if (!opts.override && Date.parse(r.seat_expires_at) < nowMs) {
      throw new CapacityError("SEAT_EXPIRED", "占座名额已过到期时间，等待释放规则处理");
    }
    const slot = this.#slotInfo(r.slot_id);
    const boat = this.db.prepare(`SELECT * FROM boats WHERE id=?`).get(slot.boat_id);

    if (!opts.override) {
      const state = this.routeStateAt(slot.route_id, nowIso);
      if (!SchedulingEngine.#tolerates(boat, state)) {
        throw new CapacityError("ROUTE_BLOCKED", `航线当前${state.condition === "closed" ? "停航" : "受限"}，不可放行`);
      }
      if (!this.#slotFeasible(slot, boat)) {
        throw new CapacityError("ROUTE_BLOCKED", "时段内存在停航/超限片段");
      }
    }

    const crewId = opts.crewId ?? this.#pickCrew(boat.id, slot.id);
    if (!crewId) throw new CapacityError("NO_CREW", "没有具备该船资质的空闲船员");

    try {
      // 到场确认：名额原子转为实际占用（同事务，失败整体回滚）
      this.#alloc("tree_pick", r.operating_day, r.id, r.tree_id, r.pick_qty);
      this.#alloc("plot_team", r.operating_day, r.id, r.plot_id, 1);
      this.#alloc("harvest_total", r.operating_day, r.id, "__day__", r.pick_qty);
      this.#alloc("boat_seat", r.operating_day, r.id, slot.id, r.party_size);
      const expires = new Date(Date.parse(slot.starts_at) + this.confirmGraceMs).toISOString();
      const newStatus = opts.override ? Status.FORCE_PASSED : Status.CONFIRMED;
      this.db.prepare(`UPDATE reservations SET status=?, confirmed_at=?, crew_id=?, seat_expires_at=?, note=?
        WHERE id=?`).run(newStatus, nowIso, crewId, expires,
        opts.override ? `force:${opts.overrideReason ?? "dual-authorised"}` : r.note, r.id);
      this.db.prepare(`UPDATE jobs SET run_at=? WHERE kind='release_noshow' AND ref_id=? AND status='pending'`)
        .run(expires, r.id);
      this.#history("reservation", r.id, "confirm",
        { slotId: slot.id, crewId, override: !!opts.override }, opts.actor ?? "gate");
      return this.#getReservation(r.id);
    } catch (e) {
      throw this.#mapCapacity(e, "到场确认失败（资源不足）");
    }
  }

  #alloc(kind, day, rid, resourceId, qty) {
    try {
      this.db.prepare(`INSERT INTO trip_allocations(kind,operating_day,reservation_id,resource_id,qty,created_at)
        VALUES (?,?,?,?,?,?)`).run(kind, day, rid, resourceId, qty, this.clock.iso());
    } catch (e) {
      throw this.#mapCapacity(e, "占用容量不足");
    }
  }

  // ---------- 登船 / 返航 ----------

  board(reservationId) {
    const nowIso = this.clock.iso();
    return this.#tx(() => {
      const r = this.#getReservation(reservationId);
      if (!r) throw new CapacityError("NOT_FOUND", "预约不存在");
      if (r.status === Status.FORCE_PASSED) {
        // 双重授权放行：跳过航线状态检查
      } else if (r.status === Status.CONFIRMED || (r.status === Status.REASSIGNED && r.crew_id != null)) {
        const slot = this.#slotInfo(r.slot_id);
        const boat = this.db.prepare(`SELECT * FROM boats WHERE id=?`).get(slot.boat_id);
        const state = this.routeStateAt(slot.route_id, nowIso);
        if (!SchedulingEngine.#tolerates(boat, state)) {
          throw new CapacityError("ROUTE_BLOCKED", "航线当前停航/受限，不可登船（如需越权请走双重授权）");
        }
      } else {
        throw new CapacityError("BAD_STATE", `当前状态 ${r.status} 不可登船`);
      }
      this.db.prepare(`UPDATE reservations SET status=?, boarded_at=? WHERE id=?`)
        .run(Status.BOARDED, nowIso, r.id);
      this.#history("reservation", r.id, "board", {}, "gate");
      return this.#getReservation(r.id);
    });
  }

  /** 返航结算（行程完成）：释放地块与船位占用，采收量按实际落账。 */
  completeTrip(reservationId, actualPick = null) {
    const nowIso = this.clock.iso();
    return this.#tx(() => {
      const r = this.#getReservation(reservationId);
      if (!r) throw new CapacityError("NOT_FOUND", "预约不存在");
      if (!ON_WATER.includes(r.status)) throw new CapacityError("BAD_STATE", `当前状态 ${r.status} 不可返航`);
      const picked = actualPick ?? r.pick_qty;
      if (picked < 0 || picked > r.pick_qty) throw new CapacityError("BAD_PICK", "实际采摘量超出预约范围");
      this.db.prepare(`UPDATE trip_allocations SET qty=?
        WHERE reservation_id=? AND kind IN ('tree_pick','harvest_total')`).run(picked, r.id);
      this.db.prepare(`DELETE FROM trip_allocations WHERE reservation_id=? AND kind IN ('plot_team','boat_seat')`).run(r.id);
      this.db.prepare(`UPDATE jobs SET status='cancelled', finished_at=? WHERE ref_id=? AND status='pending'`)
        .run(nowIso, r.id);
      this.db.prepare(`UPDATE reservations SET status=?, completed_at=?, actual_pick=? WHERE id=?`)
        .run(Status.COMPLETED, nowIso, picked, r.id);
      this.#history("reservation", r.id, "complete", { picked });
      return this.#getReservation(r.id);
    });
  }

  // ---------- 未到场释放 ----------

  /** 释放所有到期未登船的名额。跨日调用同样准确（以 seat_expires_at 为准）。 */
  releaseDueNoShows(nowMs = this.clock.nowMs()) {
    return this.#tx(() => this.#releaseDueNoShowsInner(nowMs));
  }

  #releaseDueNoShowsInner(nowMs = this.clock.nowMs()) {
    const nowIso = new Date(nowMs).toISOString();
    // reroute_pending 由环境重算/日终按停航补偿处理，不走普通 noshow 释放
    const due = this.db.prepare(`SELECT r.* FROM reservations r
      WHERE r.status IN ('reserved','confirmed','reassigned')
        AND datetime(r.seat_expires_at) <= datetime(?)`).all(nowIso);
    const released = [];
    for (const r of due) released.push(this.#markNoShow(r, "seat_expired"));
    this.db.prepare(`UPDATE jobs SET status='done', finished_at=?
      WHERE kind='release_noshow' AND status='pending' AND datetime(run_at) <= datetime(?)`)
      .run(nowIso, nowIso);
    return { released, at: nowIso };
  }

  #markNoShow(r, reason) {
    // 释放其全部实际占用（未到场者的树量/日总量预占归还）
    this.db.prepare(`DELETE FROM trip_allocations WHERE reservation_id=?`).run(r.id);
    this.db.prepare(`UPDATE reservations SET status=?, note=? WHERE id=?`)
      .run(Status.NO_SHOW, reason, r.id);
    this.db.prepare(`UPDATE jobs SET status='cancelled', finished_at=? WHERE ref_id=?`)
      .run(this.clock.iso(), r.id);
    this.#history("reservation", r.id, "no_show", { reason });
    return r.id;
  }

  // ---------- 运营取消（代金只发一次） ----------

  cancelReservation(reservationId, reason = "ops_cancel", amountCents = null) {
    return this.#tx(() => this.#cancelReservationInner(reservationId, reason, amountCents));
  }

  #cancelReservationInner(reservationId, reason = "ops_cancel", amountCents = null) {
    const r = this.#getReservation(reservationId);
    if (!r) throw new CapacityError("NOT_FOUND", "预约不存在");
    if ([Status.COMPLETED, Status.CANCELLED, Status.NO_SHOW, Status.SETTLED].includes(r.status)) {
      throw new CapacityError("BAD_STATE", `当前状态 ${r.status} 不可取消`);
    }
    this.db.prepare(`DELETE FROM trip_allocations WHERE reservation_id=?`).run(r.id);
    this.db.prepare(`UPDATE jobs SET status='cancelled', finished_at=? WHERE ref_id=? AND status='pending'`)
      .run(this.clock.iso(), r.id);
    this.db.prepare(`UPDATE reservations SET status=? WHERE id=?`).run(Status.CANCELLED, r.id);
    const voucher = this.#issueVoucher(r, reason, amountCents ?? this.closeVoucherCentsFor(reason));
    this.#history("reservation", r.id, "cancel", { reason, voucher: voucher?.id ?? null }, "ops");
    return { reservation: this.#getReservation(r.id), voucher };
  }

  closeVoucherCentsFor(reason) {
    return reason === "route_closed" ? this.closeVoucherCents : 0;
  }

  #issueVoucher(r, reason, amountCents) {
    const issueKey = `${r.id}:${reason}`;
    const id = `V-${randomUUID()}`;
    const info = this.db.prepare(`INSERT INTO vouchers(id,reservation_id,reason,issue_key,amount_cents,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(issue_key) DO NOTHING RETURNING id`).run(
      id, r.id, reason, issueKey, amountCents, this.clock.iso());
    if (info.changes === 0) {
      const existing = this.db.prepare(`SELECT * FROM vouchers WHERE issue_key=?`).get(issueKey);
      return existing;
    }
    this.#history("voucher", id, "issue", { reservationId: r.id, reason, amountCents });
    return this.db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(id);
  }

  claimVoucher(voucherId, claimedBy) {
    return this.#tx(() => {
      const v = this.db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(voucherId);
      if (!v) throw new CapacityError("NOT_FOUND", "代金权益不存在");
      if (v.status === "claimed") throw new CapacityError("ALREADY_CLAIMED", "代金权益已领取，不可重复领取");
      if (v.status === "void") throw new CapacityError("VOID", "代金权益已作废（团队已被强制放行）");
      const res = this.db.prepare(`UPDATE vouchers SET status='claimed', claimed_at=?, claimed_by=? WHERE id=? AND status='issued'`)
        .run(this.clock.iso(), claimedBy, voucherId);
      if (res.changes === 0) throw new CapacityError("NOT_CLAIMABLE", "代金权益当前不可领取");
      this.#history("voucher", voucherId, "claim", { by: claimedBy }, claimedBy);
      return this.db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(voucherId);
    });
  }

  // ---------- 环境事件：迟到/重复，按有效时间重算 ----------

  /**
   * 接收环境事件。重复事件（同航线+同有效时间+同 dedupKey）直接忽略；
   * 迟到事件正常入表并触发重算——重算是状态闸驱动的，重复调用结果稳定。
   */
  ingestEnvEvent(input) {
    return this.#tx(() => {
      const route = this.db.prepare(`SELECT * FROM routes WHERE id=?`).get(input.routeId);
      if (!route) throw new CapacityError("NOT_FOUND", "航线不存在");
      const id = input.id ?? `E-${randomUUID()}`;
      const dedupKey = input.dedupKey ?? "default";
      try {
        this.db.prepare(`INSERT INTO env_events(id,route_id,condition,water_level,wind_level,effective_at,received_at,dedup_key)
          VALUES (?,?,?,?,?,?,?,?)`).run(
          id, input.routeId, input.condition, input.waterLevel ?? null, input.windLevel ?? null,
          input.effectiveAt, this.clock.iso(), dedupKey);
      } catch (e) {
        if (String(e.message).includes("UNIQUE")) {
          this.#history("env_event", id, "duplicate_ignored", { routeId: input.routeId, effectiveAt: input.effectiveAt });
          return { duplicate: true, routeId: input.routeId, effectiveAt: input.effectiveAt, actions: [] };
        }
        throw e;
      }
      this.#history("env_event", id, "ingest", { routeId: input.routeId, condition: input.condition, effectiveAt: input.effectiveAt });
      const actions = this.#recomputeRoute(input.routeId);
      this.db.prepare(`UPDATE env_events SET applied=1 WHERE id=?`).run(id);
      return { duplicate: false, eventId: id, routeId: input.routeId, actions };
    });
  }

  /**
   * 按有效时间重算一条航线上所有未结行程：
   * - 已登船且当下不可航 → 避险（sheltered），不取消、不重复补偿；
   * - 尚未登船且本时段不可航 → 确定性改派；改派无门 → 取消并发代金（仅一次）；
   * - 已完成 → 不触动（留待结算流程）。
   * 改派只移动 boat_seat，tree/plot/day 占用不变，因此总采收上限守恒。
   */
  #recomputeRoute(routeId) {
    const actions = [];
    const trips = this.db.prepare(`SELECT r.* FROM reservations r
      JOIN route_slots s ON s.id = r.slot_id
      WHERE s.route_id = ? AND r.status IN (${ACTIVE.map(() => "?").join(",")})
      ORDER BY r.id`)
      .all(routeId, ...ACTIVE);

    for (const r of trips) {
      const slot = this.#slotInfo(r.slot_id);
      const boat = this.db.prepare(`SELECT * FROM boats WHERE id=?`).get(slot.boat_id);

      // 已登船：不可航即避险；已避险则保持（不重复动作、不补偿）
      if (r.status === Status.BOARDED) {
        if (!this.#slotFeasible(slot, boat)
          || !SchedulingEngine.#tolerates(boat, this.routeStateAt(routeId, this.clock.iso()))) {
          this.db.prepare(`UPDATE reservations SET status=? WHERE id=? AND status='boarded'`)
            .run(Status.SHELTERED, r.id);
          if (this.#changed(r.id, Status.SHELTERED)) {
            this.#history("reservation", r.id, "shelter", { routeId });
            actions.push({ reservationId: r.id, action: "shelter" });
          }
        }
        continue;
      }
      if (r.status === Status.SHELTERED || r.status === Status.FORCE_PASSED) continue;

      if (r.status === Status.REROUTE_PENDING) {
        // 迟到的复航事件可能已让某时段重新可行
        const target = this.#findAlternative(r, slot, boat, { includeCurrent: true });
        if (target) {
          this.#applyReassign(r, target, actions);
        } else if (!this.#futureSlotRemains(routeId)) {
          // 当天已无任何后续时段，重排无望 → 取消并补偿（券仅发一次）
          const result = this.#cancelReservationInner(r.id, "route_closed", this.closeVoucherCents);
          actions.push({ reservationId: r.id, action: "cancel", voucherId: result.voucher?.id ?? null });
        }
        continue;
      }

      // reserved / confirmed / reassigned：尚未登船
      if (this.#slotFeasible(slot, boat)) continue;
      const alt = this.#findAlternative(r, slot, boat);
      if (alt) {
        this.#applyReassign(r, alt, actions);
      } else if (this.#futureSlotRemains(routeId)) {
        // 暂无可改派时段，但当天还有后续时段：挂起等待迟到的复航事件
        this.db.prepare(`UPDATE reservations SET status=? WHERE id=?`)
          .run(Status.REROUTE_PENDING, r.id);
        this.#history("reservation", r.id, "reroute_pending", { slotId: slot.id });
        actions.push({ reservationId: r.id, action: "reroute_pending" });
      } else {
        // 已无后续时段 → 取消并补偿；issue_key 保证重复重算也只发一次
        const result = this.#cancelReservationInner(r.id, "route_closed", this.closeVoucherCents);
        actions.push({ reservationId: r.id, action: "cancel", voucherId: result.voucher?.id ?? null });
      }
    }
    return actions;
  }

  /** 当天是否还存在结束时间晚于当前时钟的时段（挂起团队是否还有重排盼头）。 */
  #futureSlotRemains(routeId) {
    return !!this.db.prepare(`SELECT 1 FROM route_slots
      WHERE route_id=? AND ends_at > ? LIMIT 1`).get(routeId, this.clock.iso());
  }

  #applyReassign(r, target, actions) {
    const confirmed = r.crew_id != null; // 已到场确认才持有船位/船员
    if (confirmed) {
      // 只移动 boat_seat；tree/plot/day 占用不变，总采收上限守恒
      this.db.prepare(`DELETE FROM trip_allocations WHERE reservation_id=? AND kind='boat_seat'`).run(r.id);
      this.#alloc("boat_seat", r.operating_day, r.id, target.slot.id, r.party_size);
    }
    const crewId = confirmed ? target.crewId : null;
    const expires = confirmed
      ? new Date(Date.parse(target.slot.starts_at) + this.confirmGraceMs).toISOString()
      : target.slot.starts_at;
    this.db.prepare(`UPDATE reservations SET slot_id=?, crew_id=?, status=?, seat_expires_at=? WHERE id=?`)
      .run(target.slot.id, crewId, Status.REASSIGNED, expires, r.id);
    this.db.prepare(`UPDATE jobs SET run_at=? WHERE kind='release_noshow' AND ref_id=? AND status='pending'`)
      .run(expires, r.id);
    this.#history("reservation", r.id, "reassign", { toSlot: target.slot.id, crewId, confirmed });
    actions.push({ reservationId: r.id, action: "reassign", toSlot: target.slot.id });
  }

  #changed(id, status) {
    return this.db.prepare(`SELECT status FROM reservations WHERE id=?`).get(id)?.status === status;
  }

  /**
   * 确定性挑选改派时段：同服务地块、结束时间晚于当前时钟、船型够载、
   * 全程可航、船位空闲、有资质空闲船员；按 (starts_at, slot_id) 排序取第一。
   * includeCurrent 时允许返回当前时段（用于挂起团队判断原时段是否已恢复）。
   * 纯读 + 固定排序，重复事件、乱序事件或多次重算都得到同一选择。
   */
  #findAlternative(r, currentSlot, currentBoat, { includeCurrent = false } = {}) {
    const nowIso = this.clock.iso();
    const slots = this.db.prepare(`SELECT s.* FROM route_slots s
      JOIN route_plots rp ON rp.route_id = s.route_id
      JOIN boats b ON b.id = s.boat_id
      WHERE rp.plot_id = ? AND substr(s.starts_at,1,10) = ?
        AND s.ends_at > ? AND b.capacity >= ? AND b.active = 1
        AND s.id NOT IN (SELECT resource_id FROM trip_allocations WHERE kind='boat_seat')
      ORDER BY s.starts_at, s.id`).all(r.plot_id, r.operating_day, nowIso, r.party_size);
    for (const s of slots) {
      if (!includeCurrent && s.id === currentSlot.id) continue;
      const boat = s.id === currentSlot.id ? currentBoat
        : this.db.prepare(`SELECT * FROM boats WHERE id=?`).get(s.boat_id);
      if (!this.#slotFeasible(s, boat)) continue;
      // 未确认团队不占船位，无需船员；已确认团队需要可派出的资质船员
      if (r.crew_id != null) {
        const crewId = this.#pickCrew(s.boat_id, s.id);
        if (!crewId) continue;
        return { slot: s, boat, crewId };
      }
      return { slot: s, boat, crewId: null };
    }
    return null;
  }

  // ---------- 人工强制放行（双重授权 + 理由） ----------

  /**
   * 登记一名授权人。必须两名不同授权人、各自填写理由；
   * 第二人登记成功后原子执行越权确认（仍受树/地块/日总量/船位容量约束）。
   */
  forcePassApprove(reservationId, approver, reason) {
    if (!approver || !reason || !String(reason).trim()) {
      throw new CapacityError("BAD_REASON", "强制放行必须填写授权人与理由");
    }
    return this.#tx(() => {
      const r = this.#getReservation(reservationId);
      if (!r) throw new CapacityError("NOT_FOUND", "预约不存在");
      const existing = this.db.prepare(`SELECT approver FROM force_pass_approvals WHERE reservation_id=?`)
        .all(reservationId).map((x) => x.approver);
      if (existing.includes(approver)) throw new CapacityError("DUP_APPROVER", "同一授权人不可重复授权");
      this.db.prepare(`INSERT INTO force_pass_approvals(reservation_id,approver,reason,created_at)
        VALUES (?,?,?,?)`).run(reservationId, approver, String(reason).trim(), this.clock.iso());
      this.#history("reservation", reservationId, "force_approve", { approver, reason }, approver);

      const approvals = this.db.prepare(`SELECT * FROM force_pass_approvals WHERE reservation_id=? ORDER BY id`)
        .all(reservationId);
      let forceConfirmed = false;
      if (approvals.length >= 2) {
        if (r.status === Status.RESERVED) {
          // 以 override 方式走正常占用流程（容量触发器依旧生效）
          this.#confirmArrivalInner(reservationId, { override: true, overrideReason: reason, actor: approver });
          forceConfirmed = true;
        } else if (r.status === Status.CONFIRMED
          || (r.status === Status.REASSIGNED && r.crew_id != null)) {
          this.db.prepare(`UPDATE reservations SET status=?, note=? WHERE id=?`)
            .run(Status.FORCE_PASSED, `force:${reason}`, r.id);
          this.#history("reservation", reservationId, "force_override_board", { reason }, approver);
          forceConfirmed = true;
        } else if ((r.status === Status.REASSIGNED && r.crew_id == null)
          || r.status === Status.REROUTE_PENDING) {
          // 改派/挂起中但尚未确认：双重授权后原子完成占用
          this.db.prepare(`UPDATE reservations SET status='reserved' WHERE id=?`).run(r.id);
          this.#confirmArrivalInner(reservationId, { override: true, overrideReason: reason, actor: approver });
          forceConfirmed = true;
        } else if (r.status === Status.CANCELLED && r.operating_day === this.clock.day()) {
          // 当日因停航被自动取消的名额，双重授权后可复活；容量约束重新校验，原代金作废
          this.db.prepare(`UPDATE vouchers SET status='void' WHERE reservation_id=? AND reason='route_closed' AND status='issued'`)
            .run(r.id);
          this.db.prepare(`UPDATE reservations SET status='reserved' WHERE id=?`).run(r.id);
          this.#confirmArrivalInner(reservationId, { override: true, overrideReason: reason, actor: approver });
          forceConfirmed = true;
        }
      }
      return {
        reservationId,
        approvals: approvals.map((a) => ({ approver: a.approver, reason: a.reason })),
        authorised: approvals.length >= 2,
        forceConfirmed
      };
    });
  }

  // ---------- 服务恢复：继续当天未结流程 ----------

  /** 重启后调用：释放到期名额，重算所有有未结行程航线的环境状态。 */
  recover() {
    return this.#tx(() => {
      const release = this.#releaseDueNoShowsInner();
      const routeIds = this.db.prepare(`SELECT DISTINCT s.route_id FROM reservations r
        JOIN route_slots s ON s.id = r.slot_id
        WHERE r.status IN (${ACTIVE.map(() => "?").join(",")})`).all(...ACTIVE).map((x) => x.route_id);
      const recomputed = [];
      for (const routeId of routeIds) recomputed.push({ routeId, actions: this.#recomputeRoute(routeId) });
      this.#history("system", "*", "recover", { released: release.released.length, routes: routeIds.length });
      return { released: release.released, recomputed };
    });
  }

  // ---------- 日终结算（可注入时钟） ----------

  settleDay(operatingDay) {
    const nowIso = this.clock.iso();
    return this.#tx(() => {
      const day = this.db.prepare(`SELECT * FROM harvest_days WHERE operating_day=?`).get(operatingDay);
      if (!day) throw new CapacityError("NOT_FOUND", "采收日不存在");
      if (day.settled) {
        const rows = this.db.prepare(`SELECT * FROM settlements WHERE operating_day=?`).all(operatingDay);
        return { operatingDay, settled: true, idempotent: true, settlements: rows };
      }
      // 日终：仍挂起的停航团队按停航取消并补偿（券幂等）
      const pending = this.db.prepare(`SELECT * FROM reservations
        WHERE operating_day=? AND status='reroute_pending'`).all(operatingDay);
      for (const r of pending) {
        this.#cancelReservationInner(r.id, "route_closed", this.closeVoucherCents);
      }
      // 当天所有未到场/未登船名额按 no_show 释放
      const open0 = this.db.prepare(`SELECT * FROM reservations
        WHERE operating_day=? AND status IN ('reserved','confirmed','reassigned')`).all(operatingDay);
      for (const r of open0) this.#markNoShow(r, "day_end_unarrived");

      const open = this.db.prepare(`SELECT * FROM reservations WHERE operating_day=?
        AND status IN ('completed','boarded','sheltered','force_passed')`).all(operatingDay);
      const settlements = [];
      for (const r of open) {
        let outcome;
        if (r.status === "completed") outcome = "completed";
        else if (r.status === "sheltered") outcome = "sheltered";
        else if (r.status === "force_passed") outcome = "force_passed";
        else outcome = "boarded_unreturned";
        const picked = r.status === "completed" ? r.actual_pick : 0;
        // 在航未归：释放其地块、船位及尚未落袋的采收量
        if (outcome !== "completed") {
          this.db.prepare(`DELETE FROM trip_allocations WHERE reservation_id=?`).run(r.id);
        }
        this.db.prepare(`INSERT INTO settlements(operating_day,reservation_id,team_id,outcome,picked,settled_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(operating_day,reservation_id) DO NOTHING`)
          .run(operatingDay, r.id, r.team_id, outcome, picked, nowIso);
        this.db.prepare(`UPDATE reservations SET status='settled' WHERE id=?`).run(r.id);
        settlements.push(this.db.prepare(`SELECT * FROM settlements WHERE reservation_id=?`).get(r.id));
        this.#history("reservation", r.id, "settle", { outcome, picked });
      }
      this.db.prepare(`UPDATE harvest_days SET settled=1, settled_at=? WHERE operating_day=?`).run(nowIso, operatingDay);
      this.#history("harvest_day", operatingDay, "day_settled", { count: settlements.length });
      return { operatingDay, settled: true, settlements };
    });
  }

  // ---------- 容量审计 ----------

  capacityAudit(operatingDay) {
    // used = 已确认团队的实际占用（触发器保证不越限，审计再独立核验一遍）
    // promised = 尚未到场/改派中的名额（不占份额，仅供运营观察承诺量）
    const trees = this.db.prepare(`SELECT t.id, t.plot_id, t.ripe_qty,
        COALESCE((SELECT SUM(qty) FROM trip_allocations a WHERE a.kind='tree_pick'
          AND a.operating_day=? AND a.resource_id=t.id),0) AS used,
        COALESCE((SELECT SUM(pick_qty) FROM reservations r WHERE r.operating_day=?
          AND r.tree_id=t.id AND r.status IN ('reserved','reassigned')),0) AS promised
      FROM trees t WHERE t.active=1`).all(operatingDay, operatingDay);
    const plots = this.db.prepare(`SELECT p.id, p.team_cap,
        COALESCE((SELECT COUNT(*) FROM trip_allocations a WHERE a.kind='plot_team'
          AND a.operating_day=? AND a.resource_id=p.id),0) AS used,
        COALESCE((SELECT COUNT(*) FROM reservations r WHERE r.operating_day=?
          AND r.plot_id=p.id AND r.status IN ('reserved','reassigned')),0) AS promised
      FROM plots p WHERE p.active=1`).all(operatingDay, operatingDay);
    const day = this.db.prepare(`SELECT d.*,
        COALESCE((SELECT SUM(qty) FROM trip_allocations a WHERE a.kind='harvest_total'
          AND a.operating_day=d.operating_day),0) AS used,
        COALESCE((SELECT SUM(pick_qty) FROM reservations r WHERE r.operating_day=d.operating_day
          AND r.status IN ('reserved','reassigned')),0) AS promised
      FROM harvest_days d WHERE d.operating_day=?`).get(operatingDay);
    const seats = this.db.prepare(`SELECT s.id, s.boat_id, s.starts_at, s.ends_at,
        (SELECT COUNT(*) FROM trip_allocations a WHERE a.kind='boat_seat' AND a.resource_id=s.id) AS occupied
      FROM route_slots s WHERE substr(s.starts_at,1,10)=?`).all(operatingDay);

    const violations = [];
    for (const t of trees) {
      if (t.used > t.ripe_qty) violations.push({ kind: "tree", id: t.id, used: t.used, cap: t.ripe_qty });
    }
    for (const p of plots) {
      if (p.used > p.team_cap) violations.push({ kind: "plot", id: p.id, used: p.used, cap: p.team_cap });
    }
    if (day && day.used > day.total_cap) {
      violations.push({ kind: "day", id: operatingDay, used: day.used, cap: day.total_cap });
    }
    for (const s of seats) {
      if (s.occupied > 1) violations.push({ kind: "boat_slot", id: s.id, used: s.occupied, cap: 1 });
    }
    // 船员重复排班审计（数据库亦有唯一索引兜底）
    const crewConflicts = this.db.prepare(`SELECT crew_id, slot_id, COUNT(*) n FROM reservations
      WHERE operating_day=? AND crew_id IS NOT NULL
        AND status IN ('confirmed','boarded','reassigned','sheltered','force_passed')
      GROUP BY crew_id, slot_id HAVING n > 1`).all(operatingDay);
    for (const c of crewConflicts) {
      violations.push({ kind: "crew", id: `${c.crew_id}@${c.slot_id}`, used: c.n, cap: 1 });
    }
    return { operatingDay, day, trees, plots, seats, violations, ok: violations.length === 0 };
  }

  history(entityId, limit = 100) {
    if (entityId) {
      return this.db.prepare(`SELECT * FROM change_history WHERE entity_id=? ORDER BY id DESC LIMIT ?`).all(entityId, limit);
    }
    return this.db.prepare(`SELECT * FROM change_history ORDER BY id DESC LIMIT ?`).all(limit);
  }

  getReservation(id) { return this.#getReservation(id); }
  listReservations(day) {
    return this.db.prepare(`SELECT * FROM reservations WHERE operating_day=? ORDER BY id`).all(day);
  }
  listVouchers(reservationId = null) {
    if (reservationId) return this.db.prepare(`SELECT * FROM vouchers WHERE reservation_id=? ORDER BY id`).all(reservationId);
    return this.db.prepare(`SELECT * FROM vouchers ORDER BY id`).all();
  }

  close() { this.db.close(); }
}
