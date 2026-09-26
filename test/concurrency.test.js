/**
 * 场景一：并发到场不会超卖。
 * 多个真实操作系统线程（worker_threads）各持独立连接，在同一时刻确认不同预约，
 * 竞争同一棵树/地块/船位/日总量；BEGIN IMMEDIATE + 容量触发器保证成功者数恰为容量允许数。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { SchedulingEngine, FakeClock } from "../src/engine.js";
import { DAY } from "./helpers.js";

const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "workers", "confirm-worker.js");

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wetland-"));
  return { dir, file: path.join(dir, "park.db") };
}

function confirmConcurrent(dbPath, items) {
  return Promise.all(items.map(({ id, at }) => new Promise((resolve, reject) => {
    const w = new Worker(workerFile, { workerData: { dbPath, reservationId: id, atIso: at } });
    w.on("message", resolve);
    w.on("error", reject);
  })));
}

test("并发确认同一棵树：成功者采摘量之和不超过可摘果量", async () => {
  const { dir, file } = tempDb();
  const clock = new FakeClock(`${DAY}T07:00:00.000Z`);
  const setup = new SchedulingEngine({ path: file, clock });
  setup.seed({
    plots: [{ id: "P1", name: "P", teamCap: 10 }],
    trees: [{ id: "T1", plotId: "P1", ripeQty: 100 }],
    boats: [{ id: "B1", name: "b", capacity: 20, maxWind: 9, minWater: 0 }],
    crew: ["C1", "C2", "C3", "C4"].map((id) => ({ id, name: id, boatIds: ["B1"] })),
    routes: [{ id: "R1", name: "r", plotIds: ["P1"] }],
    slots: [
      ["S1", "08:00", "10:00"], ["S2", "10:30", "12:30"],
      ["S3", "13:00", "15:00"], ["S4", "15:30", "17:30"]
    ].map(([id, s, e]) => ({ id, routeId: "R1", boatId: "B1",
      startsAt: `${DAY}T${s}:00.000Z`, endsAt: `${DAY}T${e}:00.000Z` })),
    days: [{ operatingDay: DAY, totalCap: 10000 }]
  });
  // 4 支团队各申请 40 斤，容量 100 → 至多 2 支成功
  const ids = [];
  ["S1", "S2", "S3", "S4"].forEach((slotId, i) => {
    const r = setup.createReservation({
      id: `RR-${i}`, teamId: `team-${i}`, treeId: "T1", slotId, partySize: 4, pickQty: 40
    });
    ids.push(r.id);
  });
  setup.close();

  const results = await confirmConcurrent(file, ids.map((id) => ({ id, at: `${DAY}T07:30:00.000Z` })));
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  assert.equal(ok.length, 2, `恰好 2 支成功，实际 ${ok.length}（结果: ${JSON.stringify(results)}）`);
  assert.equal(fail.length, 2);
  assert.ok(fail.every((r) => r.code === "CAPACITY"));

  // 独立审计连接复核：实际占用绝不越限
  const auditEng = new SchedulingEngine({ path: file, clock: new FakeClock(`${DAY}T12:00:00.000Z`) });
  const audit = auditEng.capacityAudit(DAY);
  assert.equal(audit.ok, true, `审计不得有违规: ${JSON.stringify(audit.violations)}`);
  const treeUsed = audit.trees.find((t) => t.id === "T1").used;
  assert.equal(treeUsed, 80);
  // 每个成功团队占用不同船位，无一时段被两队共用
  assert.ok(audit.seats.every((s) => s.occupied <= 1));
  auditEng.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("并发确认同一时段船位与地块：只有一支团队能进", async () => {
  const { dir, file } = tempDb();
  const clock = new FakeClock(`${DAY}T07:00:00.000Z`);
  const setup = new SchedulingEngine({ path: file, clock });
  setup.seed({
    plots: [{ id: "P1", name: "P", teamCap: 1 }],
    trees: [
      { id: "T1", plotId: "P1", ripeQty: 1000 },
      { id: "T2", plotId: "P1", ripeQty: 1000 }
    ],
    boats: [{ id: "B1", name: "b", capacity: 20, maxWind: 9, minWater: 0 }],
    crew: [{ id: "C1", name: "c", boatIds: ["B1"] }],
    routes: [{ id: "R1", name: "r", plotIds: ["P1"] }],
    slots: [{ id: "S1", routeId: "R1", boatId: "B1",
      startsAt: `${DAY}T08:00:00.000Z`, endsAt: `${DAY}T10:00:00.000Z` }],
    days: [{ operatingDay: DAY, totalCap: 10000 }]
  });
  const r1 = setup.createReservation({ id: "A1", teamId: "t1", treeId: "T1", slotId: "S1", partySize: 3, pickQty: 10 });
  const r2 = setup.createReservation({ id: "A2", teamId: "t2", treeId: "T2", slotId: "S1", partySize: 3, pickQty: 10 });
  setup.close();

  const results = await confirmConcurrent(file, [r1.id, r2.id].map((id) => ({ id, at: `${DAY}T07:30:00.000Z` })));
  assert.equal(results.filter((r) => r.ok).length, 1, `同一船位/地块只能进一支: ${JSON.stringify(results)}`);

  const auditEng = new SchedulingEngine({ path: file, clock: new FakeClock(`${DAY}T12:00:00.000Z`) });
  const audit = auditEng.capacityAudit(DAY);
  assert.equal(audit.ok, true);
  assert.equal(audit.seats.find((s) => s.id === "S1").occupied, 1);
  assert.equal(audit.plots.find((p) => p.id === "P1").used, 1);
  auditEng.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
