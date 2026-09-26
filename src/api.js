import { AppError, ErrorCode } from "./errors.js";

/**
 * 构造 JSON API 的 HTTP 请求处理器。
 * - 角色：gate（闸机端）、ops（运营中心）；通过 Bearer Token 区分。
 * - 所有响应均为 JSON：{ ok:true, data } 或 { ok:false, error:{code,message,details} }。
 */
export function createApiHandler(engine, { tokens = defaultTokens(), now } = {}) {
  const routes = buildRoutes(engine);

  return async function handler(req, res) {
    const started = now ? new Date(now()) : null;
    void started;
    try {
      const url = new URL(req.url, "http://localhost");
      const method = req.method.toUpperCase();
      const role = authenticate(req, tokens);

      const match = matchRoute(routes, method, url.pathname);
      if (!match) throw new AppError(ErrorCode.NOT_FOUND, "接口不存在", { status: 404 });
      if (!match.roles.includes(role)) {
        throw new AppError(ErrorCode.UNAUTHORIZED, `该接口需要权限: ${match.roles.join("/")}`, { status: 403 });
      }

      const body = method === "GET" || method === "DELETE" ? {} : await readJson(req);
      const ctx = { role, query: url.searchParams, body };
      const data = await match.action(match.params, ctx);
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const code = err instanceof AppError ? err.code : "internal_error";
      const message = err instanceof AppError ? err.message : "服务器内部错误";
      if (!(err instanceof AppError)) {
        // 记录非预期错误，便于恢复排查；不向调用端泄露堆栈。
        console.error("[api] unhandled:", err);
      }
      sendJson(res, status, {
        ok: false,
        error: { code, message, ...(err.details ? { details: err.details } : {}) }
      });
    }
  };
}

function defaultTokens() {
  return { gate: process.env.GATE_TOKEN || "gate-token", ops: process.env.OPS_TOKEN || "ops-token" };
}

function authenticate(req, tokens) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token && token === tokens.ops) return "ops";
  if (token && token === tokens.gate) return "gate";
  throw new AppError(ErrorCode.UNAUTHORIZED, "缺少或无效的访问令牌", { status: 401 });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > 1_048_576) { reject(new AppError(ErrorCode.VALIDATION, "请求体过大", { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        reject(new AppError(ErrorCode.VALIDATION, "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length
  });
  res.end(buf);
}

// —— 路由 ————————————————————————————————————————————————————————————————————

function buildRoutes(eng) {
  const r = [];
  const add = (method, pattern, roles, action) => r.push({ method, pattern, roles, action });

  // —— 闸机端 ——
  add("POST", /^\/api\/gate\/walk-in$/, ["gate"], (_p, { body }) =>
    eng.walkIn(body));
  add("POST", /^\/api\/gate\/bookings\/([^/]+)\/check-in$/, ["gate"], (p, { body }) =>
    eng.checkIn({ bookingId: p[0], ...body }));
  add("POST", /^\/api\/gate\/bookings\/([^/]+)\/board$/, ["gate"], (p, { body }) =>
    eng.board({ bookingId: p[0], ...body }));
  add("POST", /^\/api\/gate\/bookings\/([^/]+)\/complete$/, ["gate"], (p, { body }) =>
    eng.complete({ bookingId: p[0], ...body }));
  add("GET", /^\/api\/gate\/bookings\/([^/]+)$/, ["gate", "ops"], (p) =>
    eng.getBooking(p[0]));

  // —— 运营端：资源建档 ——
  add("POST", /^\/api\/ops\/plots$/, ["ops"], (_p, { body }) => eng.upsertPlot(body));
  add("POST", /^\/api\/ops\/trees$/, ["ops"], (_p, { body }) => eng.upsertTree(body));
  add("POST", /^\/api\/ops\/tree-capacity$/, ["ops"], (_p, { body }) =>
    eng.setTreeCapacity(body.treeId, body.capDate, body.availableKg));
  add("POST", /^\/api\/ops\/boats$/, ["ops"], (_p, { body }) => eng.upsertBoat(body));
  add("POST", /^\/api\/ops\/crew$/, ["ops"], (_p, { body }) => eng.upsertCrew(body));
  add("POST", /^\/api\/ops\/routes$/, ["ops"], (_p, { body }) => eng.upsertRoute(body));
  add("POST", /^\/api\/ops\/sailings$/, ["ops"], (_p, { body }) => eng.createSailing(body));
  add("POST", /^\/api\/ops\/teams$/, ["ops"], (_p, { body }) => eng.upsertTeam(body));

  // —— 运营端：调度 ——
  add("POST", /^\/api\/ops\/bookings$/, ["ops"], (_p, { body }) => {
    const id = eng.reserve(body);
    return eng.getBooking(id);
  });
  add("GET", /^\/api\/ops\/bookings$/, ["ops"], (_p, { query }) =>
    eng.listBookings({ capDate: query.get("capDate"), status: query.get("status") }));
  add("GET", /^\/api\/ops\/bookings\/([^/]+)$/, ["ops"], (p) => eng.getBooking(p[0]));

  add("POST", /^\/api\/ops\/events$/, ["ops"], (_p, { body }) => eng.reportEnvEvent(body));
  add("POST", /^\/api\/ops\/bookings\/([^/]+)\/force-check-in$/, ["ops"], (p, { body }) =>
    eng.forceApproveCheckIn({ bookingId: p[0], ...body }));

  add("POST", /^\/api\/ops\/vouchers\/([^/]+)\/claim$/, ["ops"], (p, { body }) =>
    eng.claimVoucher({ voucherId: p[0], ...body }));
  add("GET", /^\/api\/ops\/vouchers$/, ["ops"], (_p, { query }) =>
    eng.listVouchers({ bookingId: query.get("bookingId") }));

  add("POST", /^\/api\/ops\/release-expired$/, ["ops"], (_p, { body }) =>
    eng.releaseExpired(body));
  add("POST", /^\/api\/ops\/settlement$/, ["ops"], (_p, { body }) =>
    eng.runDailySettlement(body));
  add("POST", /^\/api\/ops\/recover$/, ["ops"], (_p, { body }) => eng.recover(body));
  add("GET", /^\/api\/ops\/audit$/, ["ops"], (_p, { query }) =>
    eng.capacityAudit({ capDate: query.get("capDate") }));

  // —— 健康检查 ——
  add("GET", /^\/healthz$/, ["gate", "ops"], () => ({ status: "ok" }));

  return r;
}

function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = pathname.match(route.pattern);
    if (m) return { ...route, params: m.slice(1) };
  }
  return null;
}
