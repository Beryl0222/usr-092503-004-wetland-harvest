import { createServer } from "node:http";
import { openDatabase } from "./db.js";
import { SchedulingEngine } from "./engine.js";
import { createClock } from "./clock.js";
import { createApiHandler } from "./api.js";

/**
 * 装配应用：打开持久化库（默认文件 wetland.db），构造引擎与 API。
 * 时钟可注入（FIXED_CLOCK_ISO），便于日终结算与恢复的确定性运行。
 */
export function createApp({ dbPath = process.env.DB_PATH || "wetland.db", clock = createClock(process.env.FIXED_CLOCK_ISO || undefined) } = {}) {
  const db = openDatabase(dbPath);
  const engine = new SchedulingEngine(db, {
    clock,
    pricePerKg: Number(process.env.PRICE_PER_KG || 20),
    voucherPerKg: Number(process.env.VOUCHER_PER_KG || 10),
    graceMinutes: Number(process.env.GRACE_MINUTES || 20)
  });
  const handler = createApiHandler(engine);
  return { db, engine, clock, handler };
}

/** 周期推进未结流程：释放逾期名额。日终结算由运营端显式触发。 */
function startHousekeeping(engine, intervalMs) {
  const timer = setInterval(() => {
    try { engine.releaseExpired(); } catch (err) { console.error("[housekeeping]", err); }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  const app = createApp();
  startHousekeeping(app.engine, Number(process.env.HOUSEKEEPING_MS || 30_000));
  const server = createServer(app.handler);
  server.listen(port, () => {
    console.log(`湿地采收调度引擎已启动: http://localhost:${port} (db=${process.env.DB_PATH || "wetland.db"})`);
  });
}
