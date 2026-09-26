import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "../../src/db.js";
import { SchedulingEngine } from "../../src/engine.js";
import { createClock } from "../../src/clock.js";

// 每个线程独立连接同一个数据库文件，产生真实的 SQLite 写锁竞争。
const db = openDatabase(workerData.dbPath);
const eng = new SchedulingEngine(db, { clock: createClock(workerData.at) });

parentPort.postMessage({ type: "ready" });

parentPort.on("message", (msg) => {
  if (msg !== "go") return;
  // 每个线程都尝试确认全部候补名额，制造最强竞争；正确实现下每个名额至多被确认一次。
  const results = [];
  for (const id of workerData.bookingIds) {
    try {
      eng.checkIn({ bookingId: id, at: workerData.at });
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, code: err.code || "error" });
    }
  }
  parentPort.postMessage({ type: "done", results });
  db.close();
});
