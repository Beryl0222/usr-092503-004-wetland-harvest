import { randomUUID } from "node:crypto";
import { createClock } from "./clock.js";
import { AppError, ErrorCode, isUniqueViolation } from "./errors.js";

/**
 * 调度引擎。
 *
 * 并发模型：SQLite 单库 + WAL；所有写操作在 `BEGIN IMMEDIATE` 事务中执行，
 * 文件写锁把并发到场/改派串行化。应用层在 SQLITE_BUSY 时有限重试。
 * 容量正确性不依赖"先查后插"的时序：写事务互斥 + occupancy 占用合计 + 唯一索引，
 * 同一份额绝不被两组同时占用。
 */
export class SchedulingEngine {
  constructor(db, { clock = createClock(), pricePerKg = 20, voucherPerKg = 10, graceMinutes = 20 } = {}) {
    this.db = db;
    this.clock = clock;
    this.pricePerKg = pricePerKg;
    this.voucherPerKg = voucherPerKg;
    this.graceMinutes = graceMinutes;

    // 预编译常用语句。
    this.#prepareStatements();
  }

  #prepareStatements() {
    const d = this.db;
    this.stmts = {
      occSlotUsed: d.prepare(
        `SELECT COALESCE(SUM(kg),0) AS u FROM occupancy
         WHERE resource_type='slot' AND scope_ref=? AND cap_date=? AND active=1`),
      occBoatUsed: d.prepare(
        `SELECT COALESCE(SUM(kg),0) AS u FROM occupancy
         WHERE resource_type='boat' AND resource_id=? AND scope_ref=? AND cap_date=? AND active=1`),
      occTreeUsed: d.prepare(
        `SELECT COALESCE(SUM(kg),0) AS u FROM occupancy
         WHERE resource_type='tree' AND resource_id=? AND cap_date=? AND active=1`),
      occPlotUsed: d.prepare(
        `SELECT COALESCE(SUM(o.kg),0) AS u FROM occupancy o
         JOIN trees t ON t.id=o.resource_id
         WHERE o.resource_type='tree' AND o.cap_date=? AND t.plot_id=? AND o.active=1`),
      occInsert: d.prepare(
        `INSERT INTO occupancy(booking_id,cap_date,resource_type,resource_id,scope_ref,kg,active,created_at)
         VALUES(?,?,?,?,?,?,1,?)`),
      occRelease: d.prepare(
        `UPDATE occupancy SET active=0, released_at=?, release_reason=?
         WHERE booking_id=? AND active=1`),
      occReleaseSlotBoat: d.prepare(
        `UPDATE occupancy SET active=0, released_at=?, release_reason='reassign_temp'
         WHERE booking_id=? AND active=1 AND resource_type IN ('slot','boat')`),
      occReinstateSlotBoat: d.prepare(
        `UPDATE occupancy SET active=1, released_at=NULL, release_reason=NULL
         WHERE booking_id=? AND release_reason='reassign_temp' AND resource_type IN ('slot','boat')`),
    };
  }

  // —— 事务 ————————————————————————————————————————————————————————————————

  #tx(fn, { attempts = 40 } = {}) {
    const db = this.db;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
        lastErr = err;
        if (err instanceof AppError) throw err;
        if (isUniqueViolation(err)) {
          throw new AppError(ErrorCode.CONFLICT, "资源冲突或重复操作", { status: 409 });
        }
        if (err?.code !== "SQLITE_BUSY" && err?.code !== "SQLITE_LOCKED") throw err;
        // 写锁竞争：退避后由下一轮重试重新读取最新容量。
      }
    }
    throw lastErr;
  }

  #mustGet(sql, params, what) {
    const row = this.db.prepare(sql).get(...params);
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, `${what}不存在`, { status: 404 });
    return row;
  }

  #log(entity, entityId, action, summary = {}, operator = null) {
    this.db.prepare(
      `INSERT INTO change_log(at,entity,entity_id,action,summary_json,operator)
       VALUES(?,?,?,?,?,?)`
    ).run(this.clock.iso(), entity, entityId, action, JSON.stringify(summary), operator);
  }

  #timeline(bookingId, fromStatus, toStatus, reason, eventKey = null) {
    this.db.prepare(
      `INSERT INTO booking_timeline(booking_id,from_status,to_status,at,reason,event_key)
       VALUES(?,?,?,?,?,?)`
    ).run(bookingId, fromStatus, toStatus, this.clock.iso(), reason, eventKey);
  }

  #meta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE meta_key=?").get(key)?.value ?? null;
  }

  currency() { return this.#meta("currency") ?? "CNY"; }

  // —— 资源注册 ————————————————————————————————————————————————————————————

  upsertPlot({ id, name, dailyCapKg }) {
    const cap = normInt(dailyCapKg, "地块保育上限");
    this.db.prepare(
      `INSERT INTO plots(id,name,daily_cap_kg) VALUES(?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, daily_cap_kg=excluded.daily_cap_kg, active=1`
    ).run(id, name, cap);
    this.#log("plot", id, "upsert", { dailyCapKg: cap });
    return this.getPlot(id);
  }

  getPlot(id) {
    return this.#mustGet("SELECT * FROM plots WHERE id=?", [id], "地块");
  }

  upsertTree({ id, plotId, name }) {
    this.#mustGet("SELECT id FROM plots WHERE id=?", [plotId], "地块");
    this.db.prepare(
      `INSERT INTO trees(id,plot_id,name) VALUES(?,?,?)
       ON CONFLICT(id) DO UPDATE SET plot_id=excluded.plot_id, name=excluded.name`
    ).run(id, plotId, name);
    this.#log("tree", id, "upsert", { plotId });
    return this.db.prepare("SELECT * FROM trees WHERE id=?").get(id);
  }

  setTreeCapacity(treeId, capDate, availableKg) {
    const kg = normInt(availableKg, "可摘果量");
    this.#mustGet("SELECT id FROM trees WHERE id=?", [treeId], "树木");
    this.db.prepare(
      `INSERT INTO tree_capacity(tree_id,cap_date,available_kg) VALUES(?,?,?)
       ON CONFLICT(tree_id,cap_date) DO UPDATE SET available_kg=excluded.available_kg`
    ).run(treeId, capDate, kg);
    this.#log("tree", treeId, "set_capacity", { capDate, availableKg: kg });
    return { treeId, capDate, availableKg: kg };
  }

  upsertBoat({ id, name, payloadKg }) {
    const p = normInt(payloadKg, "船只载荷");
    this.db.prepare(
      `INSERT INTO boats(id,name,payload_kg) VALUES(?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload_kg=excluded.payload_kg`
    ).run(id, name, p);
    this.#log("boat", id, "upsert", { payloadKg: p });
    return this.db.prepare("SELECT * FROM boats WHERE id=?").get(id);
  }

  upsertCrew({ id, name, certs = [] }) {
    this.db.prepare(
      `INSERT INTO crew_members(id,name,certs_json) VALUES(?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, certs_json=excluded.certs_json`
    ).run(id, name, JSON.stringify([...new Set(certs)]));
    return this.db.prepare("SELECT * FROM crew_members WHERE id=?").get(id);
  }

  upsertRoute({ id, name, treeIds = [] }) {
    this.db.prepare(
      `INSERT INTO routes(id,name) VALUES(?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name`
    ).run(id, name);
    const ins = this.db.prepare("INSERT OR IGNORE INTO route_trees(route_id,tree_id) VALUES(?,?)");
    for (const t of treeIds) {
      this.#mustGet("SELECT id FROM trees WHERE id=?", [t], "树木");
      ins.run(id, t);
    }
    this.#log("route", id, "upsert", { treeIds });
    return this.db.prepare("SELECT * FROM routes WHERE id=?").get(id);
  }

  createSailing({
    id, routeId, boatId, capDate, departHhmm, arriveHhmm,
    teamCapacity, requiredCerts = [], crewIds = []
  }) {
    return this.#tx(() => {
      this.#mustGet("SELECT id FROM routes WHERE id=?", [routeId], "航线");
      const boat = this.#mustGet("SELECT * FROM boats WHERE id=?", [boatId], "船只");
      const cap = normInt(teamCapacity, "队伍名额");
      const departAt = combine(capDate, departHhmm);
      const arriveAt = combine(capDate, arriveHhmm);
      if (arriveAt <= departAt) throw new AppError(ErrorCode.VALIDATION, "到达时间必须晚于出发时间");

      const clash = this.db.prepare(
        `SELECT id FROM sailings
         WHERE boat_id=? AND status<>'closed' AND NOT (arrive_at<=? OR depart_at>=?)`
      ).get(boatId, departAt, arriveAt);
      if (clash) throw new AppError(ErrorCode.CONFLICT, `船只该时段已安排航次 ${clash.id}`, { status: 409 });

      this.db.prepare(
        `INSERT INTO sailings(id,route_id,boat_id,cap_date,depart_at,arrive_at,
           team_capacity,required_certs_json,status)
         VALUES(?,?,?,?,?,?,?,?, 'open')`
      ).run(id, routeId, boatId, capDate, departAt, arriveAt, cap, JSON.stringify([...new Set(requiredCerts)]));

      const addCrew = this.db.prepare("INSERT OR IGNORE INTO crew_assignments(sailing_id,crew_id) VALUES(?,?)");
      for (const c of crewIds) {
        const crew = this.#mustGet("SELECT * FROM crew_members WHERE id=?", [c], "船员");
        const have = new Set(JSON.parse(crew.certs_json));
        for (const need of requiredCerts) {
          if (!have.has(need)) throw new AppError(ErrorCode.VALIDATION, `船员 ${c} 缺少资质 ${need}`);
        }
        addCrew.run(id, c);
      }
      void boat;
      this.#log("sailing", id, "create", { routeId, boatId, capDate, departAt, arriveAt, teamCapacity: cap });
      return this.getSailing(id);
    });
  }

  getSailing(id) {
    const s = this.#mustGet("SELECT * FROM sailings WHERE id=?", [id], "航次");
    s.required_certs = JSON.parse(s.required_certs_json);
    s.crew_ids = this.db.prepare("SELECT crew_id FROM crew_assignments WHERE sailing_id=?").all(id).map(r => r.crew_id);
    return s;
  }

  upsertTeam({ id, name, demandKg }) {
    const d = normInt(demandKg, "团队需求量");
    this.db.prepare(
      `INSERT INTO teams(id,name,demand_kg) VALUES(?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, demand_kg=excluded.demand_kg`
    ).run(id, name, d);
    return this.db.prepare("SELECT * FROM teams WHERE id=?").get(id);
  }

  // —— 预约 ————————————————————————————————————————————————————————————————

  /**
   * 创建预约。
   * kind='guaranteed'：预占份额（树/地块/船/名额）；到场只需在截止前确认。
   * kind='waitlist'：不预占，到场时原子抢占实时剩余容量。
   * shares 形如 [{treeId, kg}]；省略时按需求量在航线可达树木上贪心切分。
   */
  reserve({ bookingId = null, teamId, sailingId, kind = "guaranteed", shares = null, graceMinutes = null }) {
    return this.#tx(() =>
      this.#reserveInTx({ bookingId, teamId, sailingId, kind, shares, graceMinutes }));
  }

  #reserveInTx({ bookingId, teamId, sailingId, kind, shares, graceMinutes }) {
    const team = this.#mustGet("SELECT * FROM teams WHERE id=?", [teamId], "团队");
    const sailing = this.#mustGet("SELECT * FROM sailings WHERE id=?", [sailingId], "航次");
    if (sailing.status === "closed") throw new AppError(ErrorCode.ROUTE_CLOSED, "航线已停航，无法预约", { status: 409 });
    if (kind !== "guaranteed" && kind !== "waitlist") throw new AppError(ErrorCode.VALIDATION, "未知预约类型");

    const plan = shares ? normalizeShares(shares) : planShares(this.db, sailing, team.demand_kg, this.stmts);
    const totalKg = sum(plan, "kg");
    if (totalKg > team.demand_kg) throw new AppError(ErrorCode.VALIDATION, "分配份额超过团队需求量");
    // 保证类预约自动规划必须全额满足；候补允许先排队（不预占），到场时再原子抢占。
    if (!shares && kind === "guaranteed" && totalKg < team.demand_kg) {
      throw new AppError(ErrorCode.CAPACITY,
        `可规划份额 ${totalKg}kg 不足团队需求 ${team.demand_kg}kg`, { status: 409 });
    }
    if (totalKg === 0 && kind === "guaranteed") {
      throw new AppError(ErrorCode.CAPACITY, "当前无可用采收份额", { status: 409 });
    }

    const grace = graceMinutes ?? this.graceMinutes;
    const deadline = new Date(new Date(sailing.depart_at).getTime() - grace * 60_000).toISOString();
    const id = bookingId || `bk_${randomUUID()}`;
    const now = this.clock.iso();
    const status = kind === "guaranteed" ? "reserved" : "waitlisted";

    // 先建名额行（occupancy 外键依赖 bookings），再写入占用。
    this.db.prepare(
      `INSERT INTO bookings(id,team_id,sailing_id,cap_date,kind,status,kg_confirmed,
          deadline,reserved_shares_json,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(id, teamId, sailingId, sailing.cap_date, kind, status,
      kind === "guaranteed" ? totalKg : 0, deadline, JSON.stringify(plan), now);

    if (kind === "guaranteed") {
      this.#occupyAll({ bookingId: id, sailing, plan, totalKg, now });
    }

    this.#timeline(id, null, status, "reserve");
    this.#log("booking", id, "reserve", { sailingId, kind, shares: plan, deadline });
    return id;
  }

  // —— 到场确认（核心：原子占用） ——————————————————————————————————————————

  checkIn({ bookingId, at = null, force = false } = {}) {
    return this.#tx(() => this.#checkInInTx({ bookingId, at, force }));
  }

  /**
   * 单写事务内：校验截止/航线/资质；候补原子抢占实时份额；预占团队仅翻转状态。
   * 成功生成不可变行程。force 用于双重授权后的强制放行。
   */
  #checkInInTx({ bookingId, at = null, force = false }) {
    const now = at ? new Date(at).toISOString() : this.clock.iso();
    const b = this.#mustGet("SELECT * FROM bookings WHERE id=?", [bookingId], "名额");
    const sailing = this.#mustGet("SELECT * FROM sailings WHERE id=?", [b.sailing_id], "航次");

    if (!["reserved", "waitlisted"].includes(b.status)) {
      throw new AppError(ErrorCode.CONFLICT, `名额当前状态 ${b.status} 不可确认`, { status: 409 });
    }
    if (new Date(now) > new Date(b.deadline) && !force) {
      throw new AppError(ErrorCode.LATE, `已超过到场截止时间 ${b.deadline}`, { status: 409, details: { deadline: b.deadline } });
    }
    if (sailing.status === "closed" && !force) {
      throw new AppError(ErrorCode.ROUTE_CLOSED, "航线已停航", { status: 409 });
    }

    let plan;
    let totalKg;
    if (b.kind === "guaranteed") {
      plan = JSON.parse(b.reserved_shares_json);
      totalKg = b.kg_confirmed;
    } else {
      const team = this.#mustGet("SELECT * FROM teams WHERE id=?", [b.team_id], "团队");
      plan = planShares(this.db, sailing, team.demand_kg, this.stmts);
      totalKg = sum(plan, "kg");
      // 候补/现场团队原子抢占：必须全额满足需求，否则一个份额都不占。
      if (totalKg < team.demand_kg) {
        throw new AppError(ErrorCode.CAPACITY,
          `剩余份额 ${totalKg}kg 不足团队需求 ${team.demand_kg}kg`, { status: 409 });
      }
      this.#occupyAll({ bookingId: b.id, sailing, plan, totalKg, now });
      this.db.prepare(
        "UPDATE bookings SET kg_confirmed=?, reserved_shares_json=? WHERE id=?"
      ).run(totalKg, JSON.stringify(plan), b.id);
    }
    this.#verifyCrew(sailing);

    this.db.prepare(
      `UPDATE bookings SET status='confirmed', confirmed_at=? WHERE id=?`
    ).run(now, b.id);
    this.#timeline(b.id, b.status, "confirmed", force ? "force_check_in" : "check_in");
    this.#writeItinerary(b.id, sailing, plan, "confirmed", now);
    this.#log("booking", b.id, "check_in", { shares: plan, kg: totalKg, forced: force });
    return this.getBooking(b.id);
  }

  /** 现场无预约团队直接到场：建候补名额后原子抢占。 */
  walkIn({ teamId, sailingId, at = null } = {}) {
    const created = this.reserve({ teamId, sailingId, kind: "waitlist" });
    return this.checkIn({ bookingId: created, at });
  }

  #verifyCrew(sailing) {
    const required = JSON.parse(sailing.required_certs_json);
    if (required.length === 0) return;
    const crew = this.db.prepare(
      `SELECT c.certs_json AS cj FROM crew_assignments a JOIN crew_members c ON c.id=a.crew_id
       WHERE a.sailing_id=?`
    ).all(sailing.id);
    const have = new Set(crew.flatMap(r => JSON.parse(r.cj)));
    const missing = required.filter(c => !have.has(c));
    if (missing.length) throw new AppError(ErrorCode.VALIDATION, `航次缺少资质: ${missing.join(",")}`, { status: 409 });
  }

  /**
   * 当前事务内写入：名额 + 船载荷 + 逐树份额，并校验全部容量。
   * 任一不足抛 CAPACITY → 外层事务回滚，不产生部分占用。
   */
  #occupyAll({ bookingId, sailing, plan, totalKg, now }) {
    const d = this.db;
    const S = this.stmts;

    const slotsUsed = S.occSlotUsed.get(sailing.id, sailing.cap_date).u;
    if (slotsUsed + 1 > sailing.team_capacity) {
      throw new AppError(ErrorCode.CAPACITY, `航次名额不足（已用 ${slotsUsed}/${sailing.team_capacity}）`, { status: 409 });
    }

    const boatUsed = S.occBoatUsed.get(sailing.boat_id, sailing.id, sailing.cap_date).u;
    const boat = d.prepare("SELECT payload_kg FROM boats WHERE id=?").get(sailing.boat_id);
    if (boatUsed + totalKg > boat.payload_kg) {
      throw new AppError(ErrorCode.CAPACITY, `船只载荷不足（已用 ${boatUsed}/${boat.payload_kg}kg）`, { status: 409 });
    }

    // 本批次按地块汇总，确保同次占用不突破地块保育上限。
    const batchPlot = new Map();
    for (const { treeId, kg } of plan) {
      const treeRow = d.prepare("SELECT * FROM trees WHERE id=?").get(treeId);
      if (!treeRow) throw new AppError(ErrorCode.VALIDATION, `树木 ${treeId} 不存在`);
      const capRow = d.prepare("SELECT available_kg FROM tree_capacity WHERE tree_id=? AND cap_date=?").get(treeId, sailing.cap_date);
      const treeCap = capRow ? capRow.available_kg : 0;
      const treeUsed = S.occTreeUsed.get(treeId, sailing.cap_date).u;
      if (treeUsed + kg > treeCap) {
        throw new AppError(ErrorCode.CAPACITY,
          `树木 ${treeId} 可摘量不足（剩余 ${treeCap - treeUsed}kg，申请 ${kg}kg）`, { status: 409 });
      }
      batchPlot.set(treeRow.plot_id, (batchPlot.get(treeRow.plot_id) || 0) + kg);
    }
    for (const [plotId, batchKg] of batchPlot) {
      const plot = d.prepare("SELECT * FROM plots WHERE id=?").get(plotId);
      const plotUsed = S.occPlotUsed.get(sailing.cap_date, plotId).u;
      if (plotUsed + batchKg > plot.daily_cap_kg) {
        throw new AppError(ErrorCode.CAPACITY,
          `地块 ${plotId} 保育上限不足（已用 ${plotUsed}/${plot.daily_cap_kg}kg，本批 ${batchKg}kg）`, { status: 409 });
      }
    }

    S.occInsert.run(bookingId, sailing.cap_date, "slot", "slot", sailing.id, 1, now);
    S.occInsert.run(bookingId, sailing.cap_date, "boat", sailing.boat_id, sailing.id, totalKg, now);
    for (const { treeId, kg } of plan) {
      S.occInsert.run(bookingId, sailing.cap_date, "tree", treeId, null, kg, now);
    }
  }

  // —— 登船 / 完成 ————————————————————————————————————————————————————————

  board({ bookingId, at = null } = {}) {
    return this.#tx(() => {
      const now = at ? new Date(at).toISOString() : this.clock.iso();
      const b = this.#mustGet("SELECT * FROM bookings WHERE id=?", [bookingId], "名额");
      if (b.status === "sheltering") {
        this.db.prepare("UPDATE bookings SET status='boarded', boarded_at=COALESCE(boarded_at,?) WHERE id=?").run(now, b.id);
        this.#timeline(b.id, "sheltering", "boarded", "reboard");
        this.#log("booking", b.id, "reboard", {});
        return this.getBooking(b.id);
      }
      if (b.status !== "confirmed" && b.status !== "reassigned") {
        throw new AppError(ErrorCode.CONFLICT, `状态 ${b.status} 不可登船`, { status: 409 });
      }
      this.db.prepare("UPDATE bookings SET status='boarded', boarded_at=? WHERE id=?").run(now, b.id);
      this.#timeline(b.id, b.status, "boarded", "board");
      this.#log("booking", b.id, "board", {});
      return this.getBooking(b.id);
    });
  }

  complete({ bookingId, kgHarvested = null, at = null } = {}) {
    return this.#tx(() => {
      const now = at ? new Date(at).toISOString() : this.clock.iso();
      const b = this.#mustGet("SELECT * FROM bookings WHERE id=?", [bookingId], "名额");
      if (b.status !== "boarded" && b.status !== "sheltering") {
        throw new AppError(ErrorCode.CONFLICT, `状态 ${b.status} 不可完成采收`, { status: 409 });
      }
      const kg = kgHarvested == null ? b.kg_confirmed : normInt(kgHarvested, "实采量");
      if (kg > b.kg_confirmed) throw new AppError(ErrorCode.VALIDATION, "实采量不得超过确认份额");
      this.db.prepare(
        `UPDATE bookings SET status='completed', kg_harvested=?, completed_at=? WHERE id=?`
      ).run(kg, now, b.id);
      this.#timeline(b.id, b.status, "completed", "complete");
      this.#log("booking", b.id, "complete", { kg });
      return this.getBooking(b.id);
    });
  }

  // —— 逾期未到场释放（可被注入时钟驱动，比较绝对时刻，跨日准确） ————————————

  releaseExpired({ at = null } = {}) {
    const nowIso = at ? new Date(at).toISOString() : this.clock.iso();
    return this.#tx(() => this.#releaseExpiredInTx(nowIso));
  }

  #releaseExpiredInTx(nowIso) {
    const rows = this.db.prepare(
      `SELECT * FROM bookings WHERE status IN ('reserved','waitlisted') AND deadline < ?`
    ).all(nowIso);
    return rows.map(b =>
      this.#cancelHolding(b.id, b.status, "expired", "no_show_canceled", "逾期未到场", null, nowIso));
  }

  #cancelHolding(bookingId, fromStatus, guaranteedTarget, waitlistTarget, reason, eventKey, atIso) {
    const b = this.db.prepare("SELECT * FROM bookings WHERE id=?").get(bookingId);
    if (b.kind === "guaranteed") this.stmts.occRelease.run(atIso, reason, bookingId);
    const target = b.kind === "guaranteed" ? guaranteedTarget : waitlistTarget;
    this.db.prepare(
      `UPDATE bookings SET status=?, expired_at=COALESCE(expired_at,?), canceled_at=COALESCE(canceled_at,?),
         canceled_event_key=COALESCE(canceled_event_key,?) WHERE id=?`
    ).run(target, atIso, atIso, eventKey, bookingId);
    this.#timeline(bookingId, fromStatus, target, reason, eventKey);
    this.#log("booking", bookingId, "release", { reason, eventKey });
    return this.getBooking(bookingId);
  }

  // —— 环境监测事件（迟到/重复安全，按有效时间重算） ————————————————————————

  reportEnvEvent({ eventKey, routeId, condition, effectiveAt, observedAt = null, reopenAt = null, payload = {} } = {}) {
    return this.#tx(() =>
      this.#reportEnvEventInTx({ eventKey, routeId, condition, effectiveAt, observedAt, reopenAt, payload }));
  }

  #reportEnvEventInTx({ eventKey, routeId, condition, effectiveAt, observedAt, reopenAt, payload }) {
    const now = this.clock.iso();
    const eff = new Date(effectiveAt).toISOString();
    const reopen = reopenAt ? new Date(reopenAt).toISOString() : null;
    const obs = observedAt ? new Date(observedAt).toISOString() : now;
    this.#mustGet("SELECT id FROM routes WHERE id=?", [routeId], "航线");
    if (!["open", "restricted", "closed"].includes(condition)) {
      throw new AppError(ErrorCode.VALIDATION, "未知航线状态");
    }

    const existing = this.db.prepare("SELECT * FROM env_events WHERE event_key=?").get(eventKey);
    if (existing) {
      return { deduplicated: true, eventKey, condition: existing.cond, effects: this.#effectsFor(eventKey) };
    }
    this.db.prepare(
      `INSERT INTO env_events(event_key,route_id,cond,effective_at,observed_at,payload_json,processed_at)
       VALUES(?,?,?,?,?,?,?)`
    ).run(eventKey, routeId, condition, eff, obs, JSON.stringify({ ...payload, reopenAt: reopen }), now);

    const sailings = this.db.prepare(
      `SELECT * FROM sailings WHERE route_id=? AND status<>'closed' ORDER BY depart_at`
    ).all(routeId);
    for (const s of sailings) {
      // 关闭窗口 = [eff, reopen)。给出预计复航时刻后，复航后才出发的航次保持开放，
      // 作为未登船团队的改派目标；未给出复航时刻则关闭当日所有未结束航次。
      const overlaps = new Date(eff) < new Date(s.arrive_at) &&
        (!reopen || new Date(s.depart_at) < new Date(reopen));
      if (condition === "closed" && overlaps) {
        this.db.prepare("UPDATE sailings SET status='closed', closed_event_key=? WHERE id=?").run(eventKey, s.id);
        this.#log("sailing", s.id, "closed", { eventKey, effectiveAt: eff, reopenAt: reopen });
      } else if (condition === "restricted" && s.status === "open" && overlaps) {
        this.db.prepare("UPDATE sailings SET status='restricted' WHERE id=?").run(s.id);
        this.#log("sailing", s.id, "restricted", { eventKey });
      }
    }

    let effects = [];
    if (condition === "closed") effects = this.#handleClosure(routeId, eventKey, eff, reopen, now);
    else if (condition === "open") effects = this.#handleReopen(routeId, eventKey, eff, now);
    this.db.prepare("UPDATE env_events SET processed_at=? WHERE event_key=?").run(now, eventKey);
    return { deduplicated: false, eventKey, condition, effects };
  }

  #effectsFor(eventKey) {
    return this.db.prepare(
      "SELECT booking_id AS bookingId, action, detail_json AS detail FROM event_effects WHERE event_key=?"
    ).all(eventKey).map(r => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  #effectDone(eventKey, bookingId, action) {
    return !!this.db.prepare(
      "SELECT 1 FROM event_effects WHERE event_key=? AND booking_id=? AND action=?"
    ).get(eventKey, bookingId, action);
  }

  #recordEffect(eventKey, bookingId, action, detail, atIso) {
    this.db.prepare(
      `INSERT INTO event_effects(event_key,booking_id,action,detail_json,at) VALUES(?,?,?,?,?)`
    ).run(eventKey, bookingId, action, JSON.stringify(detail), atIso);
  }

  /**
   * 受关闭事件影响的名额：其航次与停航窗口 [eff, reopen) 实际重叠
   * （eff < 航次到达 且 未给复航时刻或航次出发 < 复航）。
   * 已完成团队若其航次与窗口重叠，同样纳入并送结算（结算幂等）。
   */
  #affectedBookings(routeId, eff, reopen) {
    const effT = new Date(eff).getTime();
    const reopenT = reopen ? new Date(reopen).getTime() : null;
    const all = this.db.prepare(
      `SELECT b.*, s.depart_at AS sailing_depart, s.arrive_at AS sailing_arrive
       FROM bookings b JOIN sailings s ON s.id=b.sailing_id
       WHERE s.route_id=?
         AND b.status IN ('reserved','waitlisted','confirmed','reassigned',
                          'boarded','sheltering','completed')`
    ).all(routeId);
    return all.filter(b => {
      const overlaps = effT < new Date(b.sailing_arrive).getTime() &&
        (reopenT === null || new Date(b.sailing_depart).getTime() < reopenT);
      return overlaps;
    });
  }

  #handleClosure(routeId, eventKey, eff, reopen, now) {
    const effects = [];
    for (const b0 of this.#affectedBookings(routeId, eff, reopen)) {
      const b = this.db.prepare("SELECT * FROM bookings WHERE id=?").get(b0.id);

      // 已登船 / 避险中 → 避险
      if (b.status === "boarded" || b.status === "sheltering") {
        if (!this.#effectDone(eventKey, b.id, "sheltered")) {
          this.db.prepare("UPDATE bookings SET status='sheltering' WHERE id=?").run(b.id);
          this.#timeline(b.id, b.status, "sheltering", "event_shelter", eventKey);
          this.#recordEffect(eventKey, b.id, "sheltered", {}, now);
          this.#log("booking", b.id, "shelter", { eventKey });
        }
        effects.push({ bookingId: b.id, action: "sheltered" });
        continue;
      }

      // 已完成 → 结算（已结算/已处理则幂等跳过）
      if (b.status === "completed") {
        const alreadySettled = !!this.db.prepare(
          "SELECT 1 FROM settlements WHERE booking_id=?").get(b.id);
        if (!this.#effectDone(eventKey, b.id, "settled") && !alreadySettled) {
          const s = this.#settleOne(b, "event_settle", now);
          this.#recordEffect(eventKey, b.id, "settled", { kg: s.kg, amount: s.amount }, now);
          effects.push({ bookingId: b.id, action: "settled", detail: s });
        } else {
          effects.push({ bookingId: b.id, action: "settled", detail: { idempotent: true } });
        }
        continue;
      }

      // 已确认/改派未登船 → 改派；改派不成则取消并发放一次性代金
      if (b.status === "confirmed" || b.status === "reassigned") {
        if (this.#effectDone(eventKey, b.id, "reassigned")) {
          effects.push({ bookingId: b.id, action: "reassigned", detail: { idempotent: true } });
          continue;
        }
        const moved = this.#tryReassign(b, eventKey, eff, now);
        if (moved) { effects.push({ bookingId: b.id, action: "reassigned", detail: moved }); continue; }
        const voucher = this.#cancelWithVoucher(b, eventKey, now);
        effects.push({ bookingId: b.id, action: "canceled", detail: { voucherId: voucher.id, amount: voucher.amount } });
        continue;
      }

      // 未确认（预占/候补）→ 取消，无既得补偿
      if (b.status === "reserved" || b.status === "waitlisted") {
        if (!this.#effectDone(eventKey, b.id, "canceled")) {
          this.#cancelHolding(b.id, b.status, "event_canceled", "no_show_canceled", "event_before_checkin", eventKey, now);
          this.#recordEffect(eventKey, b.id, "canceled", { compensated: false }, now);
        }
        effects.push({ bookingId: b.id, action: "canceled", detail: { compensated: false } });
      }
    }
    return effects;
  }

  /**
   * 改派到同日同航线更晚的开放航次，保持总采收上限（确认千克数与逐树份额不变）。
   * 树木份额是日级占用，改派无需变动；只需把 slot/boat 占用从旧航次移到新航次。
   * 候选按 depart_at,id 排序 → 迟到事件重放结果稳定。
   */
  #tryReassign(b, eventKey, eff, now) {
    const oldSailing = this.db.prepare("SELECT * FROM sailings WHERE id=?").get(b.sailing_id);
    const totalKg = b.kg_confirmed;

    const candidates = this.db.prepare(
      `SELECT * FROM sailings
       WHERE route_id=? AND id<>? AND cap_date=? AND status='open' AND depart_at > ?
       ORDER BY depart_at, id`
    ).all(oldSailing.route_id, oldSailing.id, oldSailing.cap_date, eff);

    for (const target of candidates) {
      // 先腾出旧航次的名额/船载，试探目标航次。
      this.stmts.occReleaseSlotBoat.run(now, b.id);
      try {
        this.#occupySlotBoat({ bookingId: b.id, sailing: target, totalKg });
      } catch (err) {
        this.stmts.occReinstateSlotBoat.run(b.id); // 回滚到旧航次
        if (err instanceof AppError && err.code === ErrorCode.CAPACITY) continue;
        throw err;
      }
      this.db.prepare("UPDATE bookings SET status='reassigned', sailing_id=? WHERE id=?").run(target.id, b.id);
      this.db.prepare(
        `INSERT INTO reassignments(booking_id,event_key,from_sailing_id,to_sailing_id,demand_kg,created_at)
         VALUES(?,?,?,?,?,?)`
      ).run(b.id, eventKey, oldSailing.id, target.id, totalKg, now);
      this.#timeline(b.id, b.status, "reassigned", "event_reassign", eventKey);
      this.#writeItinerary(b.id, target, JSON.parse(b.reserved_shares_json), `reassigned:${eventKey}`, now);
      this.#recordEffect(eventKey, b.id, "reassigned", { from: oldSailing.id, to: target.id }, now);
      this.#log("booking", b.id, "reassign", { eventKey, from: oldSailing.id, to: target.id });
      return { from: oldSailing.id, to: target.id };
    }
    return null;
  }

  #occupySlotBoat({ bookingId, sailing, totalKg }) {
    const S = this.stmts;
    const slotsUsed = S.occSlotUsed.get(sailing.id, sailing.cap_date).u;
    if (slotsUsed + 1 > sailing.team_capacity) {
      throw new AppError(ErrorCode.CAPACITY, `航次名额不足（已用 ${slotsUsed}/${sailing.team_capacity}）`, { status: 409 });
    }
    const boatUsed = S.occBoatUsed.get(sailing.boat_id, sailing.id, sailing.cap_date).u;
    const boat = this.db.prepare("SELECT payload_kg FROM boats WHERE id=?").get(sailing.boat_id);
    if (boatUsed + totalKg > boat.payload_kg) {
      throw new AppError(ErrorCode.CAPACITY, `船只载荷不足（已用 ${boatUsed}/${boat.payload_kg}kg）`, { status: 409 });
    }
    const now = this.clock.iso();
    S.occInsert.run(bookingId, sailing.cap_date, "slot", "slot", sailing.id, 1, now);
    S.occInsert.run(bookingId, sailing.cap_date, "boat", sailing.boat_id, sailing.id, totalKg, now);
  }

  #cancelWithVoucher(b, eventKey, now) {
    if (!this.#effectDone(eventKey, b.id, "canceled")) {
      this.stmts.occRelease.run(now, "event_canceled", b.id);
      this.db.prepare(
        `UPDATE bookings SET status='event_canceled', canceled_at=?, canceled_event_key=? WHERE id=?`
      ).run(now, eventKey, b.id);
      this.#timeline(b.id, b.status, "event_canceled", "event_cancel", eventKey);
      this.#recordEffect(eventKey, b.id, "canceled", { compensated: true }, now);
      this.#log("booking", b.id, "event_cancel", { eventKey });
    }
    // (booking_id,event_key) 唯一 → 重复事件/重放绝不二次发放代金。
    const amount = b.kg_confirmed * this.voucherPerKg;
    const existing = this.db.prepare("SELECT * FROM vouchers WHERE booking_id=? AND event_key=?").get(b.id, eventKey);
    if (existing) return existing;
    const id = `vch_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO vouchers(id,booking_id,event_key,amount,currency,status,issued_at)
       VALUES(?,?,?,?,?, 'issued', ?)`
    ).run(id, b.id, eventKey, amount, this.currency(), now);
    this.#log("voucher", id, "issue", { bookingId: b.id, eventKey, amount });
    return this.db.prepare("SELECT * FROM vouchers WHERE id=?").get(id);
  }

  #handleReopen(routeId, eventKey, eff, now) {
    const effects = [];
    const closed = this.db.prepare(
      `SELECT * FROM sailings WHERE route_id=? AND status='closed' AND arrive_at>?`
    ).all(routeId, eff);
    for (const s of closed) {
      this.db.prepare("UPDATE sailings SET status='open', closed_event_key=NULL WHERE id=?").run(s.id);
      this.#log("sailing", s.id, "reopen", { eventKey });
    }
    for (const b of this.db.prepare(
      `SELECT b.* FROM bookings b JOIN sailings s ON s.id=b.sailing_id
       WHERE s.route_id=? AND b.status='sheltering'`
    ).all(routeId)) {
      this.#recordEffect(eventKey, b.id, "ready_to_board", {}, now);
      effects.push({ bookingId: b.id, action: "ready_to_board" });
    }
    return effects;
  }

  // —— 代金领取（幂等） ————————————————————————————————————————————————

  claimVoucher({ voucherId, claimKey, at = null } = {}) {
    return this.#tx(() => {
      const now = at ? new Date(at).toISOString() : this.clock.iso();
      const v = this.#mustGet("SELECT * FROM vouchers WHERE id=?", [voucherId], "代金权益");
      if (v.status === "claimed") {
        throw new AppError(ErrorCode.VOUCHER_CLAIMED, "该代金权益已领取", { status: 409, details: { claimedAt: v.claimed_at } });
      }
      if (!claimKey) throw new AppError(ErrorCode.VALIDATION, "缺少领取凭证 claimKey");
      const res = this.db.prepare(
        "UPDATE vouchers SET status='claimed', claimed_at=?, claim_key=? WHERE id=? AND status='issued'"
      ).run(now, claimKey, v.id);
      if (res.changes === 0) {
        throw new AppError(ErrorCode.VOUCHER_CLAIMED, "该代金权益已领取", { status: 409 });
      }
      this.#log("voucher", v.id, "claim", { claimKey });
      return this.db.prepare("SELECT * FROM vouchers WHERE id=?").get(v.id);
    });
  }

  // —— 人工强制放行（双重授权 + 理由，单事务记录审批并执行） ————————————————

  forceApproveCheckIn({ bookingId, authorizerA, authorizerB, reason, at = null } = {}) {
    if (!authorizerA || !authorizerB || authorizerA === authorizerB) {
      throw new AppError(ErrorCode.VALIDATION, "强制放行需要两个不同的授权人", { status: 403 });
    }
    if (!reason || !String(reason).trim()) {
      throw new AppError(ErrorCode.VALIDATION, "强制放行必须填写理由", { status: 403 });
    }
    return this.#tx(() => {
      const now = at ? new Date(at).toISOString() : this.clock.iso();
      this.db.prepare(
        `INSERT INTO approvals(action,booking_id,authorizer_a,authorizer_b,reason,created_at)
         VALUES('force_check_in',?,?,?,?,?)`
      ).run(bookingId, authorizerA, authorizerB, String(reason).trim(), now);
      this.#log("booking", bookingId, "force_approved", { authorizerA, authorizerB, reason }, authorizerA);
      return this.#checkInInTx({ bookingId, at: now, force: true });
    });
  }

  // —— 日终结算（幂等，可注入时钟/日期） ————————————————————————————————————

  runDailySettlement({ capDate = null, at = null } = {}) {
    const date = capDate || this.clock.today();
    const now = at ? new Date(at).toISOString() : this.clock.iso();
    return this.#tx(() => {
      this.#releaseExpiredInTx(now);
      const rows = this.db.prepare(
        `SELECT * FROM bookings WHERE cap_date=? AND status='completed'`
      ).all(date);
      const settled = [];
      for (const b0 of rows) {
        const b = this.db.prepare("SELECT * FROM bookings WHERE id=?").get(b0.id);
        if (this.db.prepare("SELECT 1 FROM settlements WHERE booking_id=?").get(b.id)) continue;
        settled.push(this.#settleOne(b, "daily", now));
      }
      this.#log("settlement", date, "daily", { count: settled.length });
      return { capDate: date, settledCount: settled.length, settled, audit: this.#auditInTx(date) };
    });
  }

  #settleOne(b, source, now) {
    const kg = b.kg_harvested;
    const amount = kg * this.pricePerKg;
    this.db.prepare(
      `INSERT INTO settlements(booking_id,cap_date,kg,amount,currency,created_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(booking_id) DO NOTHING`
    ).run(b.id, b.cap_date, kg, amount, this.currency(), now);
    this.db.prepare("UPDATE bookings SET status='settled', settled_at=? WHERE id=?").run(now, b.id);
    this.#timeline(b.id, b.status, "settled", source);
    this.#log("booking", b.id, "settle", { kg, amount, source });
    return { bookingId: b.id, kg, amount, currency: this.currency() };
  }

  // —— 恢复：服务重启后继续当天未结流程 ————————————————————————————————————

  recover({ at = null } = {}) {
    const now = at ? new Date(at).toISOString() : this.clock.iso();
    return this.#tx(() => {
      const releasedBookings = this.#releaseExpiredInTx(now);

      const settled = [];
      for (const b of this.db.prepare(`SELECT * FROM bookings WHERE status='completed'`).all()) {
        if (!this.db.prepare("SELECT 1 FROM settlements WHERE booking_id=?").get(b.id)) {
          settled.push(this.#settleOne(b, "recover", now));
        }
      }

      // 仍挂在已关闭航次上的已确认名额：按关闭事件再尝试改派/取消（均幂等）。
      const effects = [];
      const dangling = this.db.prepare(
        `SELECT b.*, s.closed_event_key AS ev
         FROM bookings b JOIN sailings s ON s.id=b.sailing_id
         WHERE b.status IN ('confirmed','reassigned') AND s.status='closed'`
      ).all();
      for (const d of dangling) {
        const evKey = d.ev || `recover_${d.id}`;
        if (!d.ev) {
          // 航次被关闭但无事件键（理论上不发生）：补一条恢复事件。
          this.db.prepare(
            `INSERT OR IGNORE INTO env_events(event_key,route_id,cond,effective_at,observed_at,processed_at)
             SELECT ?, route_id,'closed', ?, ?, ? FROM sailings WHERE id=?`
          ).run(evKey, now, now, now, d.sailing_id);
        }
        const eff = this.db.prepare("SELECT effective_at FROM env_events WHERE event_key=?").get(evKey)?.effective_at ?? now;
        if (this.#effectDone(evKey, d.id, "reassigned") || this.#effectDone(evKey, d.id, "canceled")) continue;
        const moved = this.#tryReassign(d, evKey, eff, now);
        if (moved) effects.push({ bookingId: d.id, action: "reassigned", detail: moved });
        else {
          const v = this.#cancelWithVoucher(d, evKey, now);
          effects.push({ bookingId: d.id, action: "canceled", detail: { voucherId: v.id } });
        }
      }

      this.#log("system", "recover", "recover", { released: releasedBookings.length, settled: settled.length });
      return {
        at: now,
        released: releasedBookings.map(x => x.id),
        settled,
        effects
      };
    });
  }

  // —— 容量审计 ————————————————————————————————————————————————————————————

  capacityAudit({ capDate = null } = {}) {
    const date = capDate || this.clock.today();
    return this.#tx(() => this.#auditInTx(date));
  }

  #auditInTx(date) {
    const result = { capDate: date, resources: [], violations: [] };
    const d = this.db;
    const S = this.stmts;

    for (const r of d.prepare(
      `SELECT t.id AS tree_id, t.plot_id, COALESCE(c.available_kg,0) AS cap
       FROM trees t LEFT JOIN tree_capacity c ON c.tree_id=t.id AND c.cap_date=?`
    ).all(date)) {
      const used = S.occTreeUsed.get(r.tree_id, date).u;
      result.resources.push({ type: "tree", id: r.tree_id, plotId: r.plot_id, used, cap: r.cap, remaining: r.cap - used });
      if (used > r.cap) result.violations.push({ type: "tree", id: r.tree_id, used, cap: r.cap });
    }

    for (const r of d.prepare("SELECT id, daily_cap_kg AS cap FROM plots").all()) {
      const used = S.occPlotUsed.get(date, r.id).u;
      result.resources.push({ type: "plot", id: r.id, used, cap: r.cap, remaining: r.cap - used });
      if (used > r.cap) result.violations.push({ type: "plot", id: r.id, used, cap: r.cap });
    }

    for (const s of d.prepare("SELECT * FROM sailings WHERE cap_date=?", date).all()) {
      const boatUsed = S.occBoatUsed.get(s.boat_id, s.id, date).u;
      const boat = d.prepare("SELECT payload_kg FROM boats WHERE id=?").get(s.boat_id);
      result.resources.push({ type: "boat", id: s.boat_id, sailingId: s.id, used: boatUsed, cap: boat.payload_kg, remaining: boat.payload_kg - boatUsed });
      if (boatUsed > boat.payload_kg) result.violations.push({ type: "boat", sailingId: s.id, used: boatUsed, cap: boat.payload_kg });

      const slotUsed = S.occSlotUsed.get(s.id, date).u;
      result.resources.push({ type: "slot", id: s.id, used: slotUsed, cap: s.team_capacity, remaining: s.team_capacity - slotUsed });
      if (slotUsed > s.team_capacity) result.violations.push({ type: "slot", id: s.id, used: slotUsed, cap: s.team_capacity });
    }

    result.ok = result.violations.length === 0;
    return result;
  }

  // —— 查询 ————————————————————————————————————————————————————————————————

  getBooking(id) {
    const b = this.#mustGet("SELECT * FROM bookings WHERE id=?", [id], "名额");
    b.reserved_shares = JSON.parse(b.reserved_shares_json);
    b.itineraries = this.db.prepare(
      "SELECT version,sailing_id AS sailingId,shares_json,crew_json,reason,created_at FROM itineraries WHERE booking_id=? ORDER BY version"
    ).all(id).map(r => ({ ...r, shares: JSON.parse(r.shares_json), crew: JSON.parse(r.crew_json) }));
    return b;
  }

  listBookings({ capDate = null, status = null } = {}) {
    let sql = "SELECT id FROM bookings WHERE 1=1";
    const p = [];
    if (capDate) { sql += " AND cap_date=?"; p.push(capDate); }
    if (status) { sql += " AND status=?"; p.push(status); }
    sql += " ORDER BY created_at,id";
    return this.db.prepare(sql).all(...p).map(r => this.getBooking(r.id));
  }

  getVoucher(id) {
    return this.#mustGet("SELECT * FROM vouchers WHERE id=?", [id], "代金权益");
  }

  listVouchers({ bookingId = null } = {}) {
    if (bookingId) return this.db.prepare("SELECT * FROM vouchers WHERE booking_id=? ORDER BY issued_at").all(bookingId);
    return this.db.prepare("SELECT * FROM vouchers ORDER BY issued_at").all();
  }

  #writeItinerary(bookingId, sailing, planOrJson, reason, now) {
    const plan = typeof planOrJson === "string" ? JSON.parse(planOrJson) : planOrJson;
    const version = this.db.prepare(
      "SELECT COALESCE(MAX(version),0)+1 AS v FROM itineraries WHERE booking_id=?"
    ).get(bookingId).v;
    const crew = this.db.prepare("SELECT crew_id FROM crew_assignments WHERE sailing_id=?").all(sailing.id).map(r => r.crew_id);
    this.db.prepare(
      `INSERT INTO itineraries(booking_id,version,sailing_id,shares_json,crew_json,reason,created_at)
       VALUES(?,?,?,?,?,?,?)`
    ).run(bookingId, version, sailing.id, JSON.stringify(plan), JSON.stringify(crew), reason, now);
  }
}

// —— 纯函数 ——————————————————————————————————————————————————————————————————

function normInt(v, label) {
  if (typeof v === "boolean" || !Number.isSafeInteger(v) || v < 0) {
    throw new AppError(ErrorCode.VALIDATION, `${label}必须是非负整数`);
  }
  return v;
}

function normalizeShares(shares) {
  if (!Array.isArray(shares) || shares.length === 0) throw new AppError(ErrorCode.VALIDATION, "份额列表为空");
  return shares.map(s => {
    const treeId = s.treeId ?? s.tree_id;
    const kg = normInt(s.kg, "份额");
    if (!treeId) throw new AppError(ErrorCode.VALIDATION, "份额缺少 treeId");
    if (kg === 0) throw new AppError(ErrorCode.VALIDATION, "份额不能为 0");
    return { treeId, kg };
  });
}

function sum(rows, key) { return rows.reduce((a, r) => a + r[key], 0); }

/**
 * 在航线可达树木上按实时剩余容量贪心切分需求（确定性顺序：tree_id）。
 * 同时尊重每棵树可摘量与地块保育上限；船载/名额在 #occupyAll 统一校验。
 */
function planShares(db, sailing, demandKg, S) {
  const trees = db.prepare(
    `SELECT t.id AS tree_id, t.plot_id, COALESCE(c.available_kg,0) AS cap
     FROM route_trees rt JOIN trees t ON t.id=rt.tree_id
     LEFT JOIN tree_capacity c ON c.tree_id=t.id AND c.cap_date=?
     WHERE rt.route_id=?
     ORDER BY t.id`
  ).all(sailing.cap_date, sailing.route_id);

  const plan = [];
  let remaining = demandKg;
  const batchPlot = new Map();

  for (const t of trees) {
    if (remaining <= 0) break;
    const treeUsed = S.occTreeUsed.get(t.tree_id, sailing.cap_date).u;
    const plotUsed = S.occPlotUsed.get(sailing.cap_date, t.plot_id).u;
    const plot = db.prepare("SELECT daily_cap_kg FROM plots WHERE id=?").get(t.plot_id);
    const treeAvail = Math.max(0, t.cap - treeUsed);
    const plotAvail = Math.max(0, plot.daily_cap_kg - plotUsed - (batchPlot.get(t.plot_id) || 0));
    const give = Math.min(remaining, treeAvail, plotAvail);
    if (give > 0) {
      plan.push({ treeId: t.tree_id, kg: give });
      batchPlot.set(t.plot_id, (batchPlot.get(t.plot_id) || 0) + give);
      remaining -= give;
    }
  }
  return plan;
}

function combine(date, hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCHours(h, m || 0, 0, 0);
  return d.toISOString();
}
