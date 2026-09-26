/** 并发到场 worker：独立连接打开同一 SQLite 文件，尝试原子确认一个预约。 */
import { workerData, parentPort } from "node:worker_threads";
import { SchedulingEngine, FakeClock } from "../../src/engine.js";

const { dbPath, reservationId, atIso } = workerData;
const clock = new FakeClock(atIso);
const eng = new SchedulingEngine({ path: dbPath, clock });
try {
  const r = eng.confirmArrival(reservationId);
  parentPort.postMessage({ ok: true, reservationId, status: r.status, crew: r.crew_id });
} catch (e) {
  parentPort.postMessage({ ok: false, reservationId, code: e.code, message: e.message });
}
