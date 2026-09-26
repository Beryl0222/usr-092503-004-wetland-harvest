/**
 * 业务场景：跨日释放、停航重排稳定性、重复监测不重复补偿、服务恢复、双重授权、日终结算。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SchedulingEngine, FakeClock, CapacityError } from "../src/engine.js";
import { buildPark, DAY, iso } from "./helpers.js";

function expectError(code, fn) {
  try { fn(); } catch (e) { assert.ok(e instanceof CapacityError); assert.equal(e.code, code); return; }
  assert.fail(`预期抛出 ${code}`);
}

// ---------- 跨日释放 ----------

test("跨日释放准确：到期名额释放，未到期与次日名额不受影响", () => {
  const { eng, clock } = buildPark({}, { slots: [
    ["S1", "08:00", "10:00"],
    ["S2N", `${DAY}T23:30`.slice(11, 16), "23:59"]
  ] });
  // 次日时段
  eng.seed({
    slots: [{ id: "S1N", routeId: "R1", boatId: "B1",
      startsAt: "2026-09-27T08:00:00.000Z", endsAt: "2026-09-27T10:00:00.000Z" }],
    days: [{ operatingDay: "2026-09-27", totalCap: 1000 }]
  });
  const today = eng.createReservation({ teamId: "t1", treeId: "T1", slotId: "S1", partySize: 3, pickQty: 10 });
  const tomorrow = eng.createReservation({ teamId: "t2", treeId: "T1", slotId: "S1N", partySize: 3, pickQty: 10 });

  // 未到期不释放
  clock.setTo(iso(DAY, "07:59"));
  assert.equal(eng.releaseDueNoShows().released.length, 0);
  assert.equal(eng.getReservation(today.id).status, "reserved");

  // 跨日调用：当天 08:00 名额到期；次日名额不受影响
  clock.setTo("2026-09-27T09:00:00.000Z");
  const out = eng.releaseDueNoShows();
  assert.deepEqual(out.released, [today.id]);
  assert.equal(eng.getReservation(today.id).status, "no_show");
  assert.equal(eng.getReservation(tomorrow.id).status, "reserved");

  // 已释放名额不可重复确认；到期后确认被拒
  expectError("BAD_STATE", () => eng.confirmArrival(today.id));

  // 次日名额次日仍可确认
  clock.setTo("2026-09-27T07:30:00.000Z");
  const c = eng.confirmArrival(tomorrow.id);
  assert.equal(c.status, "confirmed");
});

test("到场确认有占座截止：迟到确认被拒，释放后名额可被他人使用", () => {
  const { eng, clock } = buildPark({}, { plotCap: 1, ripe: 50 });
  const late = eng.createReservation({ id: "LATE", teamId: "tl", treeId: "T1", slotId: "S1", partySize: 3, pickQty: 10 });
  clock.setTo(iso(DAY, "08:30"));
  expectError("SEAT_EXPIRED", () => eng.confirmArrival(late.id));
  eng.releaseDueNoShows();
  assert.equal(eng.getReservation(late.id).status, "no_show");

  // 名额已释放，另一团队可占用同一资源
  const other = eng.createReservation({ id: "OTHER", teamId: "to", treeId: "T1", slotId: "S2", partySize: 3, pickQty: 10 });
  assert.equal(eng.confirmArrival(other.id).status, "confirmed");
});

// ---------- 停航重排稳定性 ----------

test("停航重排稳定：事件接收顺序不同，最终行程一致", () => {
  function scenario(receiveOrder) {
    const { eng, clock } = buildPark();
    const x = eng.createReservation({ teamId: "tx", treeId: "T1", slotId: "S1", partySize: 4, pickQty: 20 });
    clock.setTo(iso(DAY, "08:30"));
    const closed = { routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "09:00"), dedupKey: "wind" };
    const opened = { routeId: "R1", condition: "open", effectiveAt: iso(DAY, "12:00"), dedupKey: "calm" };
    const evs = receiveOrder === "forward" ? [closed, opened] : [opened, closed];
    for (const e of evs) eng.ingestEnvEvent(e);
    const r = eng.getReservation(x.id);
    return { status: r.status, slot: r.slot_id };
  }
  const a = scenario("forward");   // 先停航（挂起）后复航（改派）
  const b = scenario("reverse");   // 先收到复航再收到停航（迟到事件按有效时间重算）
  assert.deepEqual(a, b);
  assert.equal(a.status, "reassigned");
  // S2(10:30-12:30) 与 09:00-12:00 停航相交 → 跳过；确定性落到 S3(13:00-15:00)
  assert.equal(a.slot, "S3");
});

test("重复重算不改写已登船团队：只避险一次、不补偿", () => {
  const { eng, clock } = buildPark();
  const x = eng.createReservation({ teamId: "tx", treeId: "T1", slotId: "S1", partySize: 4, pickQty: 20 });
  clock.setTo(iso(DAY, "07:40"));
  eng.confirmArrival(x.id);
  eng.board(x.id);
  clock.setTo(iso(DAY, "09:10"));
  eng.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "09:05"), dedupKey: "gust-1" });
  assert.equal(eng.getReservation(x.id).status, "sheltered");
  // 再来一条内容相同但报文不同的停航，以及任意次 recover 重算
  eng.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "09:05"), dedupKey: "gust-2" });
  eng.recover();
  assert.equal(eng.getReservation(x.id).status, "sheltered");
  assert.equal(eng.listVouchers(x.id).length, 0);
  // 复航后返航结算
  eng.ingestEnvEvent({ routeId: "R1", condition: "open", effectiveAt: iso(DAY, "09:40"), dedupKey: "calm" });
  assert.equal(eng.completeTrip(x.id, 18).status, "completed");
});

// ---------- 重复监测不重复补偿 ----------

test("重复监测不重复补偿：当天无后续时段时取消并发且仅发一张券", () => {
  const { eng, clock } = buildPark();
  const x = eng.createReservation({ teamId: "tx", treeId: "T1", slotId: "S4", partySize: 4, pickQty: 20 });
  // 17:45：S4 已结束，当天无后续时段
  clock.setTo(iso(DAY, "17:45"));
  const e1 = eng.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "16:00"), dedupKey: "storm" });
  assert.deepEqual(e1.actions.map((a) => a.action), ["cancel"]);
  assert.equal(eng.getReservation(x.id).status, "cancelled");
  const vouchers = eng.listVouchers(x.id);
  assert.equal(vouchers.length, 1);
  assert.equal(vouchers[0].reason, "route_closed");

  // 完全重复的事件报文被忽略
  const e2 = eng.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "16:00"), dedupKey: "storm" });
  assert.equal(e2.duplicate, true);
  // 迟到的复航、recover、再次停航都不会让已取消团队复活或再发券
  eng.ingestEnvEvent({ routeId: "R1", condition: "open", effectiveAt: iso(DAY, "15:00"), dedupKey: "late-open" });
  eng.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "16:30"), dedupKey: "storm-2" });
  eng.recover();
  assert.equal(eng.listVouchers(x.id).length, 1);
  assert.equal(eng.getReservation(x.id).status, "cancelled");

  // 券只能领取一次
  const v = vouchers[0];
  assert.equal(eng.claimVoucher(v.id, "tx").status, "claimed");
  expectError("ALREADY_CLAIMED", () => eng.claimVoucher(v.id, "tx"));
});

test("改派维持总采收上限：只移动船位，树/地块/日总量占用不变", () => {
  const { eng, clock } = buildPark();
  const x = eng.createReservation({ teamId: "tx", treeId: "T1", slotId: "S2", partySize: 4, pickQty: 25 });
  clock.setTo(iso(DAY, "10:00"));
  eng.confirmArrival(x.id);
  const before = eng.capacityAudit(DAY);
  // 停航覆盖 S2，复航 12:00 → 改派 S3
  eng.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "10:45"), dedupKey: "w" });
  eng.ingestEnvEvent({ routeId: "R1", condition: "open", effectiveAt: iso(DAY, "12:00"), dedupKey: "c" });
  const r = eng.getReservation(x.id);
  assert.equal(r.status, "reassigned");
  assert.equal(r.slot_id, "S3");
  const after = eng.capacityAudit(DAY);
  const tBefore = before.trees.find((t) => t.id === "T1").used;
  const tAfter = after.trees.find((t) => t.id === "T1").used;
  assert.equal(tAfter, tBefore, "树采摘占用不变");
  assert.equal(after.day.used, before.day.used, "日总采收占用不变");
  assert.equal(after.plots.find((p) => p.id === "P1").used, before.plots.find((p) => p.id === "P1").used);
  assert.equal(after.ok, true);
  // 船位只落在新时段
  assert.equal(after.seats.find((s) => s.id === "S2").occupied, 0);
  assert.equal(after.seats.find((s) => s.id === "S3").occupied, 1);
});

// ---------- 服务恢复 ----------

test("服务恢复后继续当天未结流程：到期释放 + 迟到复航完成改派", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wetland-rec-"));
  const file = path.join(dir, "park.db");
  try {
    // 故障前实例
    const a = new SchedulingEngine({ path: file, clock: new FakeClock(iso(DAY, "07:00")) });
    buildParkInto(a);
    const y = a.createReservation({ teamId: "early", treeId: "T1", slotId: "S1", partySize: 4, pickQty: 20 });
    const x = a.createReservation({ teamId: "later", treeId: "T1", slotId: "S3", partySize: 4, pickQty: 20 });
    a.confirmArrival(y.id); // 占座 08:00-08:30 到期
    // 13:30 停航：X 进入重排挂起（S4 仍在未来）
    a.clock.setTo(iso(DAY, "08:00"));
    a.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "13:30"), dedupKey: "wind" });
    assert.equal(a.getReservation(x.id).status, "reroute_pending");
    a.close();

    // 重启：11:00，recover 先释放 Y（08:30 到期未登船），X 继续挂起
    const b = new SchedulingEngine({ path: file, clock: new FakeClock(iso(DAY, "11:00")) });
    const rec = b.recover();
    assert.deepEqual(rec.released, [y.id]);
    assert.equal(b.getReservation(y.id).status, "no_show");
    assert.equal(b.getReservation(x.id).status, "reroute_pending");

    // 迟到的复航事件（有效时间 12:00）到达 → 挂起流程继续，改派 S4
    b.ingestEnvEvent({ routeId: "R1", condition: "open", effectiveAt: iso(DAY, "12:00"), dedupKey: "late-calm" });
    assert.equal(b.getReservation(x.id).slot_id, "S4");
    assert.equal(b.getReservation(x.id).status, "reassigned");

    // 团队随后到场、登船、返航、日终结算一路完成
    b.clock.setTo(iso(DAY, "15:00"));
    assert.equal(b.confirmArrival(x.id).status, "confirmed");
    b.clock.setTo(iso(DAY, "15:40"));
    b.board(x.id);
    b.completeTrip(x.id, 19);
    const s = b.settleDay(DAY);
    const row = s.settlements.find((r) => r.reservation_id === x.id);
    assert.equal(row.outcome, "completed");
    assert.equal(row.picked, 19);
    assert.equal(b.capacityAudit(DAY).ok, true);
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildParkInto(eng) {
  eng.seed({
    plots: [{ id: "P1", name: "火柿湾", teamCap: 2 }],
    trees: [{ id: "T1", plotId: "P1", ripeQty: 100 }],
    boats: [{ id: "B1", name: "b", capacity: 12, maxWind: 8, minWater: 1 }],
    crew: ["C1", "C2", "C3"].map((id) => ({ id, name: id, boatIds: ["B1"] })),
    routes: [{ id: "R1", name: "r", plotIds: ["P1"] }],
    slots: [
      ["S1", "08:00", "10:00"], ["S2", "10:30", "12:30"],
      ["S3", "13:00", "15:00"], ["S4", "15:30", "17:30"]
    ].map(([id, s, e]) => ({ id, routeId: "R1", boatId: "B1",
      startsAt: `${DAY}T${s}:00.000Z`, endsAt: `${DAY}T${e}:00.000Z` })),
    days: [{ operatingDay: DAY, totalCap: 1000 }]
  });
}

// ---------- 双重授权 ----------

test("强制放行需两名不同授权人且填写理由", () => {
  const { eng, clock } = buildPark();
  const x = eng.createReservation({ teamId: "tx", treeId: "T1", slotId: "S1", partySize: 4, pickQty: 20 });
  eng.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "07:30"), dedupKey: "early-wind" });
  clock.setTo(iso(DAY, "07:40"));
  expectError("ROUTE_BLOCKED", () => eng.confirmArrival(x.id));

  const first = eng.forcePassApprove(x.id, "manager-li", "现场核验风浪可承受");
  assert.equal(first.authorised, false);
  assert.equal(eng.getReservation(x.id).status, "reserved");
  expectError("DUP_APPROVER", () => eng.forcePassApprove(x.id, "manager-li", "再次确认"));
  expectError("BAD_REASON", () => eng.forcePassApprove(x.id, "manager-wang", "   "));

  const second = eng.forcePassApprove(x.id, "manager-wang", "调度中心同意放行");
  assert.equal(second.authorised, true);
  assert.equal(second.forceConfirmed, true);
  const r = eng.getReservation(x.id);
  assert.equal(r.status, "force_passed");
  assert.ok(r.crew_id);
  // 停航状态下仍可登船（越权）
  eng.board(x.id);
  assert.equal(eng.completeTrip(x.id, 20).status, "completed");
});

test("强制放行已取消名额时原代金作废且不可领取", () => {
  const { eng, clock } = buildPark();
  const x = eng.createReservation({ teamId: "tx", treeId: "T1", slotId: "S4", partySize: 4, pickQty: 20 });
  clock.setTo(iso(DAY, "17:45"));
  eng.ingestEnvEvent({ routeId: "R1", condition: "closed", effectiveAt: iso(DAY, "16:00"), dedupKey: "storm" });
  const v = eng.listVouchers(x.id)[0];
  assert.ok(v);
  // 当日双重授权复活
  eng.forcePassApprove(x.id, "m1", "应急恢复通航");
  const r2 = eng.forcePassApprove(x.id, "m2", "负责人核准");
  assert.equal(r2.forceConfirmed, true);
  assert.equal(eng.getReservation(x.id).status, "force_passed");
  assert.equal(eng.listVouchers(x.id)[0].status, "void");
  expectError("VOID", () => eng.claimVoucher(v.id, "tx"));
});

// ---------- 日终结算 ----------

test("日终结算：完成按实摘、在航未归零果量释放、结算幂等", () => {
  const { eng, clock } = buildPark();
  const done = eng.createReservation({ teamId: "d", treeId: "T1", slotId: "S1", partySize: 4, pickQty: 30 });
  const away = eng.createReservation({ teamId: "a", treeId: "T2", slotId: "S2", partySize: 4, pickQty: 20 });
  const idle = eng.createReservation({ teamId: "i", treeId: "T1", slotId: "S3", partySize: 2, pickQty: 5 });
  clock.setTo(iso(DAY, "07:30"));
  eng.confirmArrival(done.id);
  eng.confirmArrival(away.id);
  eng.board(done.id);
  eng.board(away.id);
  clock.setTo(iso(DAY, "09:30"));
  eng.completeTrip(done.id, 27);
  // away 始终在航未归；idle 从未到场

  const s1 = eng.settleDay(DAY);
  const m = Object.fromEntries(s1.settlements.map((r) => [r.team_id, r]));
  assert.equal(m.d.outcome, "completed");
  assert.equal(m.d.picked, 27);
  assert.equal(m.a.outcome, "boarded_unreturned");
  assert.equal(m.a.picked, 0);
  assert.equal(eng.getReservation(idle.id).status, "no_show");
  assert.equal(eng.capacityAudit(DAY).ok, true);

  // 幂等：再次结算返回同一批结果
  const s2 = eng.settleDay(DAY);
  assert.equal(s2.idempotent, true);
  assert.equal(s2.settlements.length, s1.settlements.length);
});
