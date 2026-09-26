import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { openDatabase, SchedulingEngine, createClock } from "../src/index.js";
import { seedPark, seedTeams } from "./helpers/seed.js";

const DATE = "2026-09-26";

/** 在临时目录的文件库上播种资源、团队与候补名额（供多线程共享同一文件）。 */
function setupFileDb(dir, { treeCap, sailingTeamCap, boatPayload, demands, sailingId }) {
  const db = openDatabase(join(dir, "park.db"));
  const eng = new SchedulingEngine(db, { clock: createClock("2026-09-26T06:00:00Z") });
  seedPark(eng, { date: DATE, treeCap, teamCapacity: sailingTeamCap });
  if (boatPayload) eng.upsertBoat({ id: "B_BIG", name: "采收船-大", payloadKg: boatPayload });
  seedTeams(eng, demands);
  const bookingIds = Object.keys(demands).map(teamId =>
    eng.reserve({ bookingId: `bk_${teamId}`, teamId, sailingId, kind: "waitlist" }));
  db.close();
  return bookingIds;
}

async function runContention(dir, bookingIds, { at = "2026-09-26T08:00:00Z" } = {}) {
  const workerCount = 8;
  const workers = Array.from({ length: workerCount }, () =>
    new Worker(new URL("./helpers/contention-worker.js", import.meta.url), {
      workerData: { dbPath: join(dir, "park.db"), bookingIds, at }
    }));
  await Promise.all(workers.map(w => once(w, "message"))); // 全部就绪
  workers.forEach(w => w.postMessage("go"));               // 屏障放行
  const outcomes = await Promise.all(
    workers.map(w => once(w, "message").then(([m]) => m.results))
  );
  await Promise.all(workers.map(w => w.terminate()));
  return outcomes.flat();
}

test("并发到场不会超卖：紧俏树木份额下多组同时确认", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wetland-conc-"));
  try {
    // T_A1 仅 30kg；10 个团队各需 30kg；同时到场只有 1 组能成功。
    const demands = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`GW${i}`, 30]));
    const bookingIds = setupFileDb(dir, {
      treeCap: { T_A1: 30, T_A2: 0, T_B1: 0 },
      sailingTeamCap: { N_AM: 10, N_PM: 10, S_AM: 0 },
      demands, sailingId: "N_AM"
    });

    const flat = await runContention(dir, bookingIds);
    const succeeded = flat.filter(r => r.ok);
    const unique = new Set(succeeded.map(r => r.id));

    assert.equal(succeeded.length, unique.size, "同一名额被重复确认");
    assert.equal(succeeded.length, 1, `紧俏份额期望仅 1 组成功，实际 ${succeeded.length}`);

    const auditDb = openDatabase(join(dir, "park.db"));
    const used = auditDb.prepare(
      `SELECT COALESCE(SUM(kg),0) u FROM occupancy
       WHERE resource_type='tree' AND resource_id='T_A1' AND cap_date=? AND active=1`
    ).get(DATE).u;
    assert.equal(used, 30, "树木占用超过可摘量 → 超卖");
    assert.equal(auditDb.prepare("SELECT COUNT(*) c FROM bookings WHERE status='confirmed'").get().c, 1);

    const audit = new SchedulingEngine(auditDb, { clock: createClock("2026-09-26T08:00:00Z") })
      .capacityAudit({ capDate: DATE });
    assert.equal(audit.ok, true, JSON.stringify(audit.violations));
    auditDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并发到场不会超卖：船只载荷与队伍名额同时受限", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wetland-conc2-"));
  try {
    // 树量充足，但 N_AM 名额 2、大船载荷 50；6 组各需 20kg → 至多 2 组。
    const demands = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`GB${i}`, 20]));
    const bookingIds = setupFileDb(dir, {
      treeCap: { T_A1: 500, T_A2: 500, T_B1: 0 },
      sailingTeamCap: { N_AM: 2, N_PM: 6, S_AM: 0 },
      boatPayload: 50,
      demands, sailingId: "N_AM"
    });

    const flat = await runContention(dir, bookingIds);
    const succeeded = flat.filter(r => r.ok);
    const unique = new Set(succeeded.map(r => r.id));

    assert.equal(succeeded.length, unique.size, "同一名额被重复确认");
    assert.equal(succeeded.length, 2, `名额=2 期望 2 组，实际 ${succeeded.length}`);

    const auditDb = openDatabase(join(dir, "park.db"));
    const boatUsed = auditDb.prepare(
      `SELECT COALESCE(SUM(kg),0) u FROM occupancy
       WHERE resource_type='boat' AND scope_ref='N_AM' AND cap_date=? AND active=1`
    ).get(DATE).u;
    assert.equal(boatUsed, 40, "船只载荷被突破");
    assert.equal(auditDb.prepare(
      `SELECT COALESCE(SUM(kg),0) u FROM occupancy WHERE resource_type='slot' AND scope_ref='N_AM' AND cap_date=? AND active=1`
    ).get(DATE).u, 2);

    const audit = new SchedulingEngine(auditDb, { clock: createClock("2026-09-26T08:00:00Z") })
      .capacityAudit({ capDate: DATE });
    assert.equal(audit.ok, true, JSON.stringify(audit.violations));
    auditDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
