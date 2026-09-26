import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SchedulingEngine, createClock } from "../src/index.js";
import { seedPark, seedTeams } from "./helpers/seed.js";

const DATE = "2026-09-26";

function fresh({ voucherPerKg = 10, pricePerKg = 20, graceMinutes = 20 } = {}) {
  const clock = createClock("2026-09-26T06:00:00Z");
  const db = openDatabase(":memory:");
  const eng = new SchedulingEngine(db, { clock, voucherPerKg, pricePerKg, graceMinutes });
  seedPark(eng, { date: DATE });
  return { db, eng, clock };
}

test("停航按有效时间分流：已登船避险、未登船改派、已完成结算", () => {
  const { eng, clock } = fresh();
  seedTeams(eng, { G_BOARD: 20, G_WAIT: 20, G_DONE: 20 });

  const boarded = eng.reserve({ teamId: "G_BOARD", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });
  const waiting = eng.reserve({ teamId: "G_WAIT", sailingId: "N_AM", shares: [{ treeId: "T_A2", kg: 20 }] });
  const done = eng.reserve({ teamId: "G_DONE", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 15 }, { treeId: "T_A2", kg: 5 }] });

  for (const id of [boarded, waiting, done]) eng.checkIn({ bookingId: id });
  eng.board({ bookingId: boarded });
  eng.board({ bookingId: done });
  // done 团队在 10:00 完成采收。
  clock.setNow("2026-09-26T10:00:00Z");
  eng.complete({ bookingId: done, kgHarvested: 18 });

  // 监测事件 10:30 才送达，但有效时间是 10:15（迟到），处于 N_AM 航次窗口内、N_PM(13:00) 之前。
  clock.setNow("2026-09-26T10:30:00Z");
  const res = eng.reportEnvEvent({
    eventKey: "WIND_1015", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T10:15:00Z", reopenAt: "2026-09-26T12:30:00Z"
  });
  const byId = Object.fromEntries(res.effects.map(e => [e.bookingId, e]));

  assert.equal(byId[boarded].action, "sheltered");
  assert.equal(eng.getBooking(boarded).status, "sheltering");

  assert.equal(byId[waiting].action, "reassigned");
  const w = eng.getBooking(waiting);
  assert.equal(w.status, "reassigned");
  assert.equal(w.sailing_id, "N_PM");
  // 改派保持总采收上限：确认份额仍为 20kg。
  assert.equal(w.kg_confirmed, 20);
  assert.equal(w.itineraries.length, 2, "改派应生成新版本行程");

  // 已完成团队被送结算（金额 18kg*20=360）。
  assert.equal(byId[done].action, "settled");
  assert.equal(eng.getBooking(done).status, "settled");
  const settlement = db_settlement(eng, done);
  assert.equal(settlement.amount, 360);
});

function db_settlement(eng, bookingId) {
  return eng.db.prepare("SELECT * FROM settlements WHERE booking_id=?").get(bookingId);
}

test("迟到事件重放结果稳定：改派目标确定且重复处理幂等", () => {
  const { eng, clock } = fresh();
  seedTeams(eng, { G1: 20 });
  const id = eng.reserve({ teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });
  eng.checkIn({ bookingId: id });

  clock.setNow("2026-09-26T10:00:00Z");
  const r1 = eng.reportEnvEvent({
    eventKey: "E1", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T09:30:00Z", reopenAt: "2026-09-26T12:30:00Z"
  });
  assert.equal(r1.effects[0].detail.to, "N_PM");
  assert.equal(eng.getBooking(id).sailing_id, "N_PM");

  // 重复送达同一迟到事件：去重，不再二次改派/取消。
  const r2 = eng.reportEnvEvent({
    eventKey: "E1", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T09:30:00Z", reopenAt: "2026-09-26T12:30:00Z"
  });
  assert.equal(r2.deduplicated, true);
  assert.equal(eng.getBooking(id).status, "reassigned");
  assert.equal(eng.getBooking(id).sailing_id, "N_PM");
  assert.equal(eng.db.prepare("SELECT COUNT(*) c FROM reassignments WHERE booking_id=?").get(id).c, 1);
});

test("无法改派时取消并发代金；重复监测绝不重复补偿，代金只能领一次", () => {
  const { eng, clock } = fresh({ voucherPerKg: 10 });
  seedTeams(eng, { G1: 20 });
  const id = eng.reserve({ teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });
  eng.checkIn({ bookingId: id });

  // 关闭整日北航线（不给 reopenAt）→ N_AM、N_PM 全关，无改派候选。
  clock.setNow("2026-09-26T08:50:00Z");
  const first = eng.reportEnvEvent({
    eventKey: "FLOOD", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T08:45:00Z"
  });
  assert.equal(first.effects[0].action, "canceled");
  assert.equal(eng.getBooking(id).status, "event_canceled");

  let vouchers = eng.listVouchers({ bookingId: id });
  assert.equal(vouchers.length, 1, "应发放恰好一张代金");
  assert.equal(vouchers[0].amount, 200, "20kg * 10 = 200 分/元");
  const voucherId = vouchers[0].id;

  // 重复上报同一事件：去重，不再发代金、不再产生效应。
  for (let i = 0; i < 3; i++) {
    const dup = eng.reportEnvEvent({
      eventKey: "FLOOD", routeId: "R_NORTH", condition: "closed",
      effectiveAt: "2026-09-26T08:45:00Z"
    });
    assert.equal(dup.deduplicated, true);
  }
  assert.equal(eng.listVouchers({ bookingId: id }).length, 1);
  assert.equal(eng.db.prepare("SELECT COUNT(*) c FROM event_effects WHERE event_key='FLOOD'").get().c, 1);

  // 代金只能领取一次；同一 claimKey 或重复领取均失败。
  const claimed = eng.claimVoucher({ voucherId, claimKey: "claim-001" });
  assert.equal(claimed.status, "claimed");
  assert.throws(() => eng.claimVoucher({ voucherId, claimKey: "claim-002" }),
    e => e.code === "voucher_already_claimed");
});

test("第二个关闭事件使已改派名额也无法成行时，仅补一次取消补偿", () => {
  const { eng, clock } = fresh();
  seedTeams(eng, { G1: 20 });
  const id = eng.reserve({ teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });
  eng.checkIn({ bookingId: id });

  // 上午停航、中午复航 → 改派到 N_PM。
  clock.setNow("2026-09-26T09:00:00Z");
  eng.reportEnvEvent({
    eventKey: "E_AM", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T08:55:00Z", reopenAt: "2026-09-26T12:30:00Z"
  });
  assert.equal(eng.getBooking(id).status, "reassigned");

  // 下午再度停航且不再复航 → N_PM 关闭，取消并只发一张代金。
  clock.setNow("2026-09-26T12:45:00Z");
  const r2 = eng.reportEnvEvent({
    eventKey: "E_PM", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T12:40:00Z"
  });
  assert.equal(r2.effects[0].action, "canceled");
  assert.equal(eng.listVouchers({ bookingId: id }).length, 1);
});

test("短暂停航不波及复航后才出发的航次", () => {
  const { eng, clock } = fresh();
  seedTeams(eng, { G_PM: 20 });
  // N_PM 13:00 出发；停航窗口 09:30–12:30 与其不重叠。
  const pm = eng.reserve({ teamId: "G_PM", sailingId: "N_PM", shares: [{ treeId: "T_A1", kg: 20 }] });

  clock.setNow("2026-09-26T09:35:00Z");
  const res = eng.reportEnvEvent({
    eventKey: "SHORT", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T09:30:00Z", reopenAt: "2026-09-26T12:30:00Z"
  });
  assert.deepEqual(res.effects, [], "复航后的航次不应产生任何处置");
  assert.equal(eng.getBooking(pm).status, "reserved");
  assert.equal(eng.getSailing("N_PM").status, "open");
  assert.equal(eng.getSailing("N_AM").status, "closed");
});

test("未确认预占名额遇停航直接取消且不发代金；逾期未到场释放份额", () => {
  const { eng, clock, db } = fresh();
  seedTeams(eng, { G1: 20, G2: 20 });
  const id = eng.reserve({ teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });

  clock.setNow("2026-09-26T08:30:00Z");
  const r = eng.reportEnvEvent({
    eventKey: "EARLY", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T08:25:00Z", reopenAt: "2026-09-26T12:00:00Z"
  });
  assert.equal(r.effects[0].action, "canceled");
  assert.equal(r.effects[0].detail.compensated, false);
  assert.equal(eng.listVouchers({ bookingId: id }).length, 0);
  // 占用已释放。
  const active = db.prepare("SELECT COUNT(*) c FROM occupancy WHERE booking_id=? AND active=1").get(id).c;
  assert.equal(active, 0);

  // 另一组预占但从不到场：截止（08:40）后释放，份额可被他人使用。
  const id2 = eng.reserve({ teamId: "G2", sailingId: "N_PM", shares: [{ treeId: "T_A2", kg: 20 }] });
  clock.setNow("2026-09-26T13:00:00Z");
  const released = eng.releaseExpired();
  assert.ok(released.some(b => b.id === id2));
  assert.equal(eng.getBooking(id2).status, "expired");
});
