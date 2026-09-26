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

export { openDatabase, migrate } from "./db.js";
export { SchedulingEngine } from "./engine.js";
export { createClock } from "./clock.js";
export { AppError, ErrorCode } from "./errors.js";
export { createApiHandler } from "./api.js";
export { createApp } from "./server.js";
