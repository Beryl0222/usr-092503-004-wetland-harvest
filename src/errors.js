/** 业务错误：携带稳定错误码与 HTTP 状态，API 层与测试统一据此断言。 */
export class AppError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/** 判断底层 SQL 错误是否为唯一约束冲突（资源被并发占用）。 */
export function isUniqueViolation(err) {
  return (
    err?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    /UNIQUE constraint failed/i.test(err?.message || "")
  );
}

export const ErrorCode = Object.freeze({
  VALIDATION: "validation_failed",
  NOT_FOUND: "not_found",
  CONFLICT: "state_conflict",
  LATE: "past_deadline",
  ROUTE_CLOSED: "route_unavailable",
  CAPACITY: "capacity_exhausted",
  VOUCHER_CLAIMED: "voucher_already_claimed",
  UNAUTHORIZED: "unauthorized",
  DEDUPLICATED: "event_deduplicated"
});
