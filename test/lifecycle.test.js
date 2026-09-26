import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SchedulingEngine, createClock } from "../src/index.js";
import { seedPark, seedTeams } from "./helpers/seed.js";

const DATE = "2026-09-26";

test("跨日释放准确：仅释放过期未确认名额，已确认/已登船不动", () => {
  const clock = createClock("2026-09-26T08:00:00Z");
  const db = openDatabase(":memory:");
  const eng = new SchedulingEngine(db, { clock, graceMinutes: 20 });
  seedPark(eng, { date: DATE });
  seedTeams(eng, { G_LATE: 20, G_OK: 20, G_WAIT: 20 });

  // 三组都在 N_AM：预占（截止 08:40）。
  const late = eng.reserve({ teamId: "G_LATE", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });
  const ok = eng.reserve({ teamId: "G_OK", sailingId: "N_AM", shares: [{ treeId: "T_A2", kg: 20 }] });
  const wait = eng.reserve({ teamId: "G_WAIT", sailingId: "N_PM", kind: "waitlist" }); // N_PM 截止 12:40

  // G_OK 在截止前确认。
  eng.checkIn({ bookingId: ok, at: "2026-09-26T08:30:00Z" });

  // 时钟跨过 N_AM 截止、进入次日。
  clock.setNow("2026-09-27T07:00:00Z");
  const released = eng.releaseExpired();
  const ids = released.map(b => b.id);

  assert.ok(ids.includes(late), "N_AM 未确认名额应在跨日后释放");
  assert.ok(!ids.includes(ok), "已确认名额不得被释放");
  assert.ok(ids.includes(wait), "N_PM 候补（截止12:40）次日也应释放");
  assert.equal(eng.getBooking(late).status, "expired");
  assert.equal(eng.getBooking(ok).status, "confirmed");

  // 被释放份额已归还：T_A1 占用为 0。
  const used = db.prepare(
    "SELECT COALESCE(SUM(kg),0) u FROM occupancy WHERE resource_type='tree' AND resource_id='T_A1' AND active=1"
  ).get().u;
  assert.equal(used, 0);

  // 释放幂等：再跑一次不重复处理。
  const again = eng.releaseExpired();
  assert.equal(again.length, 0);
});

test("日终结算幂等：只结算已完成名额，避险中不结算，重复执行不重复付款", () => {
  const clock = createClock("2026-09-26T06:00:00Z");
  const db = openDatabase(":memory:");
  const eng = new SchedulingEngine(db, { clock, pricePerKg: 20 });
  seedPark(eng, { date: DATE });
  seedTeams(eng, { G1: 20, G2: 20 });

  // G1 走南航线 S_AM 完成采收（北航线停航不影响它），留待日终结算。
  const done = eng.reserve({ teamId: "G1", sailingId: "S_AM", shares: [{ treeId: "T_B1", kg: 20 }] });
  // G2 走北航线 N_AM，登船后遇停航进入避险、未完成。
  const sheltered = eng.reserve({ teamId: "G2", sailingId: "N_AM", shares: [{ treeId: "T_A2", kg: 20 }] });
  eng.checkIn({ bookingId: done, at: "2026-09-26T09:05:00Z" });
  eng.board({ bookingId: done, at: "2026-09-26T09:30:00Z" });
  eng.complete({ bookingId: done, kgHarvested: 20, at: "2026-09-26T10:00:00Z" });
  eng.checkIn({ bookingId: sheltered, at: "2026-09-26T08:30:00Z" });
  eng.board({ bookingId: sheltered, at: "2026-09-26T09:00:00Z" });
  clock.setNow("2026-09-26T09:35:00Z");
  eng.reportEnvEvent({
    eventKey: "WIND", routeId: "R_NORTH", condition: "closed",
    effectiveAt: "2026-09-26T09:30:00Z", reopenAt: "2026-09-27T08:00:00Z"
  });
  assert.equal(eng.getBooking(sheltered).status, "sheltering");

  const r1 = eng.runDailySettlement({ capDate: DATE, at: "2026-09-26T23:00:00Z" });
  assert.equal(r1.settledCount, 1);
  assert.equal(r1.settled[0].amount, 400);
  assert.equal(r1.audit.ok, true);

  // 避险中未结算。
  assert.equal(db.prepare("SELECT COUNT(*) c FROM settlements").get().c, 1);

  // 重复日终结算不重复付款。
  const r2 = eng.runDailySettlement({ capDate: DATE, at: "2026-09-26T23:30:00Z" });
  assert.equal(r2.settledCount, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM settlements").get().c, 1);
});

test("服务恢复：重启后继续当天未结流程（释放逾期、补结算、收尾改派）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wetland-recover-"));
  try {
    const dbPath = join(dir, "park.db");

    // —— 第一次服务生命周期：制造若干"未结"状态后非正常退出（不结算）。 ——
    {
      const db = openDatabase(dbPath);
      const eng = new SchedulingEngine(db, { clock: createClock("2026-09-26T08:00:00Z") });
      seedPark(eng, { date: DATE });
      seedTeams(eng, { G_NOSHOW: 20, G_DONE: 20, G_DANGLING: 20 });

      // 逾期未确认。
      eng.reserve({ teamId: "G_NOSHOW", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });

      // 已完成但未结算（服务在结算前宕机）。
      const done = eng.reserve({ teamId: "G_DONE", sailingId: "N_AM", shares: [{ treeId: "T_A2", kg: 20 }] });
      eng.checkIn({ bookingId: done, at: "2026-09-26T08:30:00Z" });
      eng.board({ bookingId: done, at: "2026-09-26T09:00:00Z" });
      eng.complete({ bookingId: done, kgHarvested: 20, at: "2026-09-26T10:00:00Z" });

      // 已确认名额挂在关闭航次上，模拟"事件已落库但分流中断"：直接把 N_AM 置关闭，
      // N_PM 保持开放（事件复航时刻 12:30），供恢复时改派。
      const dangling = eng.reserve({ teamId: "G_DANGLING", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 10 }, { treeId: "T_A2", kg: 10 }] });
      eng.checkIn({ bookingId: dangling, at: "2026-09-26T08:35:00Z" });
      db.prepare(
        `INSERT INTO env_events(event_key,route_id,cond,effective_at,observed_at,processed_at)
         VALUES('E_LOST','R_NORTH','closed',?,?,NULL)`
      ).run("2026-09-26T08:50:00Z", "2026-09-26T08:50:00Z");
      db.prepare("UPDATE sailings SET status='closed', closed_event_key='E_LOST' WHERE id='N_AM'").run();
      db.close(); // 宕机
    }

    // —— 次日服务重启，新引擎连接同一文件并执行恢复。 ——
    {
      const db = openDatabase(dbPath);
      const eng = new SchedulingEngine(db, { clock: createClock("2026-09-27T07:30:00Z") });
      const rec = eng.recover();

      assert.ok(rec.released.length >= 1, "应释放逾期名额");
      assert.equal(rec.settled.length, 1, "应补结算宕机前已完成名额");
      assert.equal(rec.settled[0].amount, 400);
      const danglingEffect = rec.effects.find(e => e.action === "reassigned");
      assert.ok(danglingEffect, "应把挂在关闭航次的名额改派");
      assert.equal(danglingEffect.detail.to, "N_PM");

      // 恢复保持总采收上限：改派后确认份额不变。
      const danglingBooking = eng.listBookings({ status: "reassigned" })[0];
      assert.equal(danglingBooking.kg_confirmed, 20);

      // 恢复幂等：再跑一次不产生新动作/新结算。
      const rec2 = eng.recover();
      assert.deepEqual(rec2.settled, []);
      assert.equal(rec2.released.length, 0);
      assert.equal(rec2.effects.length, 0);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM settlements").get().c, 1);

      const audit = eng.capacityAudit({ capDate: DATE });
      assert.equal(audit.ok, true, JSON.stringify(audit.violations));
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
