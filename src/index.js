/** 调度模块识别的资源类型。 */
export const ResourceKind = Object.freeze({
  ROUTE: "route",
  BOAT: "boat",
  PLOT: "plot",
  HARVEST_QUOTA: "harvest_quota"
});

/** 环境变化对航线造成的影响。 */
export const RouteCondition = Object.freeze({
  OPEN: "open",
  RESTRICTED: "restricted",
  CLOSED: "closed"
});

export function normalizeQuota(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("采收份额必须是非负整数");
  }
  return value;
}

export { SchedulingEngine, Clock, FakeClock, Status, CapacityError } from "./engine.js";
export { openDatabase, migrate, SCHEMA_VERSION } from "./db.js";
export { createApp, createEngine } from "./api.js";
export { startServer } from "./server.js";
