/**
 * JSON HTTP API：供闸机端与运营端调用。
 *
 * 写接口支持 Idempotency-Key 请求头：同一 key 的重试返回首次结果，不重复执行。
 * 错误统一为 { error: { code, message } }，CapacityError 的 code 透传给调用方。
 */
import { CapacityError, SchedulingEngine } from "./engine.js";
import { openDatabase } from "./db.js";

const STATUS_BY_CODE = {
  NOT_FOUND: 404,
  BAD_STATE: 409,
  CAPACITY: 409,
  TREE_CAPACITY: 409,
  BOAT_FULL: 409,
  ROUTE_BLOCKED: 409,
  NO_CREW: 409,
  NO_DAY: 409,
  DAY_SETTLED: 409,
  BAD_ROUTE: 400,
  BAD_REASON: 400,
  BAD_PICK: 400,
  DUP_APPROVER: 409,
  SEAT_EXPIRED: 409,
  ALREADY_CLAIMED: 409,
  VOID: 409,
  NOT_CLAIMABLE: 409
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new CapacityError("BAD_JSON", "请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

export function createApp(engine) {
  /** 幂等包装：有 Idempotency-Key 时缓存写操作的响应（含错误）。 */
  function withIdempotency(req, res, key, fn) {
    if (key) {
      const cached = engine.db.prepare(`SELECT response FROM idempotency WHERE idem_key=?`).get(key);
      if (cached) {
        const { status, body } = JSON.parse(cached.response);
        return json(res, status, body);
      }
    }
    let status = 200;
    let body;
    try {
      body = { ok: true, data: fn() };
    } catch (e) {
      status = e instanceof CapacityError ? (STATUS_BY_CODE[e.code] ?? 400) : 500;
      body = { ok: false, error: { code: e instanceof CapacityError ? e.code : "INTERNAL", message: e.message } };
      if (status === 500) console.error(e);
    }
    // 标准幂等语义：同一 key 重放首次结果（含错误），避免网络重试产生重复占用
    if (key) {
      engine.db.prepare(`INSERT OR IGNORE INTO idempotency(idem_key,response,created_at) VALUES (?,?,?)`)
        .run(key, JSON.stringify({ status, body }), engine.clock.iso());
    }
    return json(res, status, body);
  }

  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const segments = p.split("/").filter(Boolean); // ['gate'|'ops'|'admin', ...]
    const idem = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]) : null;

    try {
      // ---------- 闸机端 ----------
      if (req.method === "POST" && segments[0] === "gate" && segments[1] === "reservations" && segments.length === 2) {
        const b = await readBody(req);
        return withIdempotency(req, res, idem, () => engine.createReservation({
          id: b.reservationId,
          teamId: require_(b.teamId, "teamId"),
          treeId: require_(b.treeId, "treeId"),
          slotId: require_(b.slotId, "slotId"),
          partySize: Number(require_(b.partySize, "partySize")),
          pickQty: Number(require_(b.pickQty, "pickQty"))
        }));
      }
      if (req.method === "POST" && segments[0] === "gate" && segments[1] === "reservations"
        && segments[3] === "confirm" && segments.length === 4) {
        const b = await readBody(req).catch(() => ({}));
        return withIdempotency(req, res, idem, () => engine.confirmArrival(segments[2], { actor: b.actor ?? "gate" }));
      }
      if (req.method === "POST" && segments[0] === "gate" && segments[1] === "reservations"
        && segments[3] === "board" && segments.length === 4) {
        await readBody(req).catch(() => ({}));
        return withIdempotency(req, res, idem, () => engine.board(segments[2]));
      }
      if (req.method === "POST" && segments[0] === "gate" && segments[1] === "reservations"
        && segments[3] === "complete" && segments.length === 4) {
        const b = await readBody(req).catch(() => ({}));
        return withIdempotency(req, res, idem,
          () => engine.completeTrip(segments[2], b.actualPick == null ? null : Number(b.actualPick)));
      }

      // ---------- 运营端 ----------
      if (req.method === "GET" && segments[0] === "ops" && segments[1] === "reservations" && segments.length === 2) {
        const day = url.searchParams.get("day") ?? engine.clock.day();
        return json(res, 200, { ok: true, data: engine.listReservations(day) });
      }
      if (req.method === "GET" && segments[0] === "ops" && segments[1] === "reservations"
        && segments.length === 3) {
        const r = engine.getReservation(segments[2]);
        if (!r) return json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "预约不存在" } });
        return json(res, 200, { ok: true, data: r });
      }
      if (req.method === "POST" && segments[0] === "ops" && segments[1] === "events" && segments.length === 2) {
        const b = await readBody(req);
        return withIdempotency(req, res, idem, () => engine.ingestEnvEvent({
          id: b.eventId,
          routeId: require_(b.routeId, "routeId"),
          condition: require_(b.condition, "condition"),
          waterLevel: b.waterLevel == null ? null : Number(b.waterLevel),
          windLevel: b.windLevel == null ? null : Number(b.windLevel),
          effectiveAt: require_(b.effectiveAt, "effectiveAt"),
          dedupKey: b.dedupKey
        }));
      }
      if (req.method === "POST" && segments[0] === "ops" && segments[1] === "reservations"
        && segments[3] === "cancel" && segments.length === 4) {
        const b = await readBody(req).catch(() => ({}));
        return withIdempotency(req, res, idem,
          () => engine.cancelReservation(segments[2], b.reason ?? "ops_cancel",
            b.amountCents == null ? null : Number(b.amountCents)));
      }
      if (req.method === "POST" && segments[0] === "ops" && segments[1] === "reservations"
        && segments[3] === "force-approve" && segments.length === 4) {
        const b = await readBody(req);
        return withIdempotency(req, res, idem, () => engine.forcePassApprove(
          segments[2], require_(b.approver, "approver"), require_(b.reason, "reason")));
      }
      if (req.method === "GET" && segments[0] === "ops" && segments[1] === "vouchers" && segments.length === 2) {
        return json(res, 200, { ok: true, data: engine.listVouchers(url.searchParams.get("reservationId")) });
      }
      if (req.method === "POST" && segments[0] === "ops" && segments[1] === "vouchers"
        && segments[3] === "claim" && segments.length === 4) {
        const b = await readBody(req);
        return withIdempotency(req, res, idem,
          () => engine.claimVoucher(segments[2], require_(b.claimedBy, "claimedBy")));
      }
      if (req.method === "POST" && segments[0] === "ops" && segments[1] === "day-end" && segments.length === 2) {
        const b = await readBody(req).catch(() => ({}));
        return withIdempotency(req, res, idem,
          () => engine.settleDay(b.operatingDay ?? engine.clock.day()));
      }
      if (req.method === "POST" && segments[0] === "ops" && segments[1] === "release-no-shows" && segments.length === 2) {
        return withIdempotency(req, res, idem, () => engine.releaseDueNoShows());
      }
      if (req.method === "GET" && segments[0] === "ops" && segments[1] === "audit" && segments.length === 2) {
        return json(res, 200, { ok: true, data: engine.capacityAudit(url.searchParams.get("day") ?? engine.clock.day()) });
      }
      if (req.method === "POST" && segments[0] === "ops" && segments[1] === "recover" && segments.length === 2) {
        return withIdempotency(req, res, idem, () => engine.recover());
      }
      if (req.method === "GET" && segments[0] === "ops" && segments[1] === "history" && segments.length === 2) {
        return json(res, 200, {
          ok: true,
          data: engine.history(url.searchParams.get("entity") ?? null,
            Number(url.searchParams.get("limit") ?? 100))
        });
      }

      // ---------- 管理端 ----------
      if (req.method === "POST" && segments[0] === "admin" && segments[1] === "seed" && segments.length === 2) {
        const b = await readBody(req);
        return withIdempotency(req, res, idem, () => engine.seed(b));
      }

      return json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `无此路由: ${req.method} ${p}` } });
    } catch (e) {
      if (e instanceof CapacityError) {
        return json(res, STATUS_BY_CODE[e.code] ?? 400, { ok: false, error: { code: e.code, message: e.message } });
      }
      console.error(e);
      return json(res, 500, { ok: false, error: { code: "INTERNAL", message: e.message } });
    }
  };
}

function require_(v, name) {
  if (v == null || v === "") throw new CapacityError("BAD_REQUEST", `缺少必填字段: ${name}`);
  return v;
}

export function createEngine(opts = {}) {
  const db = opts.db ?? openDatabase(opts.path ?? process.env.WETLAND_DB ?? ":memory:");
  return new SchedulingEngine({ ...opts, db });
}
