import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, SchedulingEngine, createClock, ErrorCode } from "../src/index.js";
import { seedPark, seedTeams } from "./helpers/seed.js";

function fresh() {
  const clock = createClock("2026-09-26T06:00:00.000Z");
  const db = openDatabase(":memory:");
  const eng = new SchedulingEngine(db, { clock, pricePerKg: 20, voucherPerKg: 10, graceMinutes: 20 });
  return { db, eng, clock, date: seedPark(eng).date };
}

test("预约即原子预占：超额树木份额被拒，不产生任何占用", () => {
  const { eng, db } = fresh();
  seedTeams(eng, { G1: 20, G2: 50 });
  eng.reserve({ teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });
  assert.throws(
    () => eng.reserve({ teamId: "G2", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 50 }] }),
    e => e.code === ErrorCode.CAPACITY
  );
  // T_A1 容量 60，仅占用 20。
  const used = db.prepare(
    `SELECT COALESCE(SUM(kg),0) u FROM occupancy WHERE resource_type='tree' AND resource_id='T_A1' AND active=1`
  ).get().u;
  assert.equal(used, 20);
});

test("到场确认生成行程，登船与完成按状态机推进", () => {
  const { eng } = fresh();
  seedTeams(eng, { G1: 20 });
  const id = eng.reserve({ teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });
  const b0 = eng.checkIn({ bookingId: id });
  assert.equal(b0.status, "confirmed");
  assert.equal(b0.itineraries.length, 1);
  assert.equal(b0.itineraries[0].shares[0].kg, 20);
  assert.equal(eng.board({ bookingId: id }).status, "boarded");
  const done = eng.complete({ bookingId: id, kgHarvested: 18 });
  assert.equal(done.status, "completed");
  assert.equal(done.kg_harvested, 18);
});

test("超过截止时间到场被拒；双重授权+理由可强制放行", () => {
  const { eng } = fresh();
  seedTeams(eng, { G1: 20 });
  const id = eng.reserve({ teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] });
  // N_AM 09:00 出发，宽限 20 分钟 → 截止 08:40。
  assert.throws(() => eng.checkIn({ bookingId: id, at: "2026-09-26T08:41:00Z" }),
    e => e.code === ErrorCode.LATE);

  // 单一授权人 / 相同两人 / 空理由都被拒。
  assert.throws(() => eng.forceApproveCheckIn({
    bookingId: id, authorizerA: "u1", authorizerB: "u1", reason: "紧急"
  }), /两个不同的授权人/);
  assert.throws(() => eng.forceApproveCheckIn({
    bookingId: id, authorizerA: "u1", authorizerB: "u2", reason: "   "
  }), /理由/);

  const b = eng.forceApproveCheckIn({
    bookingId: id, at: "2026-09-26T08:45:00Z",
    authorizerA: "dispatcher-7", authorizerB: "duty-manager-3", reason: "团队因接驳车延误，现场核实身份"
  });
  assert.equal(b.status, "confirmed");
});

test("地块保育上限优先于单树容量：跨树累计不得突破地块上限", () => {
  const clock = createClock("2026-09-26T06:00:00.000Z");
  const db = openDatabase(":memory:");
  const eng = new SchedulingEngine(db, { clock });
  // 地块上限收紧到 70，两棵树各 60。
  seedPark(eng, { treeCap: { T_A1: 60, T_A2: 60, T_B1: 40 } });
  eng.upsertPlot({ id: "P_A", name: "北地块", dailyCapKg: 70 });
  seedTeams(eng, { G1: 40, G2: 40 });
  eng.reserve({ teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 40 }] });
  // 第二组要 40：地块仅剩 30，即使 T_A2 自身有 60 也不得突破地块保育上限。
  assert.throws(
    () => eng.reserve({ teamId: "G2", sailingId: "N_AM", shares: [{ treeId: "T_A2", kg: 40 }] }),
    e => e.code === ErrorCode.CAPACITY
  );
});

test("船员资质不足的航次不允许确认", () => {
  const clock = createClock("2026-09-26T06:00:00.000Z");
  const db = openDatabase(":memory:");
  const eng = new SchedulingEngine(db, { clock });
  seedPark(eng);
  // 新建一个只有 deck 资质船员、却要求 water 的航次应在建档时失败。
  assert.throws(() => eng.createSailing({
    id: "BAD", routeId: "R_SOUTH", boatId: "B_SMALL", capDate: "2026-09-26",
    departHhmm: "16:00", arriveHhmm: "17:00", teamCapacity: 2,
    requiredCerts: ["water"], crewIds: ["C_DECK"]
  }), /缺少资质/);
});
