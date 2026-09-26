import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDatabase } from "../src/db.js";
import { SchedulingEngine } from "../src/engine.js";
import { createClock } from "../src/clock.js";
import { createApiHandler } from "../src/api.js";
import { seedPark, seedTeams } from "./helpers/seed.js";

const DATE = "2026-09-26";
const GATE = "gate-token";
const OPS = "ops-token";

async function start() {
  const db = openDatabase(":memory:");
  const eng = new SchedulingEngine(db, { clock: createClock("2026-09-26T06:00:00Z") });
  seedPark(eng, { date: DATE });
  seedTeams(eng, { G1: 20 });
  const server = createServer(createApiHandler(eng, { tokens: { gate: GATE, ops: OPS } }));
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const url = path => `http://127.0.0.1:${port}${path}`;
  return { server, eng, url, db };
}

async function call(url, { method = "GET", token, body, path } = {}) {
  const res = await fetch(path ? url(path) : url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

test("无令牌 401；闸机端访问运营接口 403", async () => {
  const { server, url } = await start();
  try {
    assert.equal((await call(url("/healthz"))).status, 401);
    assert.equal((await call(url("/healthz"), { token: "bad" })).status, 401);
    const forbidden = await call(url("/api/ops/bookings"), { token: GATE });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error.code, "unauthorized");
  } finally { server.close(); }
});

test("运营端建档+预约，闸机端到场/登船/完成全链路", async () => {
  const { server, url, eng } = await start();
  try {
    const created = await call(url("/api/ops/bookings"), {
      method: "POST", token: OPS,
      body: { teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] }
    });
    assert.equal(created.status, 200);
    const bookingId = created.json.data.id;

    const checkIn = await call(url(`/api/gate/bookings/${bookingId}/check-in`), { method: "POST", token: GATE, body: {} });
    assert.equal(checkIn.status, 200);
    assert.equal(checkIn.json.data.status, "confirmed");

    const board = await call(url(`/api/gate/bookings/${bookingId}/board`), { method: "POST", token: GATE, body: {} });
    assert.equal(board.json.data.status, "boarded");

    const complete = await call(url(`/api/gate/bookings/${bookingId}/complete`), {
      method: "POST", token: GATE, body: { kgHarvested: 18 }
    });
    assert.equal(complete.json.data.status, "completed");
    assert.equal(complete.json.data.kg_harvested, 18);

    // 闸机端可查询名额。
    const got = await call(url(`/api/gate/bookings/${bookingId}`), { token: GATE });
    assert.equal(got.status, 200);
  } finally { server.close(); }
});

test("停航后闸机端不得放行；停航航次不再接纳新预约", async () => {
  const { server, url } = await start();
  try {
    const { json: { data: booking } } = await call(url("/api/ops/bookings"), {
      method: "POST", token: OPS, body: { teamId: "G1", sailingId: "N_PM", shares: [{ treeId: "T_A1", kg: 20 }] }
    });
    // 关闭整日北航线：未确认名额被事件取消。
    const ev = await call(url("/api/ops/events"), {
      method: "POST", token: OPS,
      body: { eventKey: "CLOSE_ALL", routeId: "R_NORTH", condition: "closed", effectiveAt: "2026-09-26T08:00:00Z" }
    });
    assert.equal(ev.status, 200);

    // 闸机对已被停航取消的名额放行 → 409，不得放行。
    const blocked = await call(url(`/api/gate/bookings/${booking.id}/check-in`), { method: "POST", token: GATE, body: {} });
    assert.equal(blocked.status, 409);
    assert.ok(["state_conflict", "route_unavailable"].includes(blocked.json.error.code));

    // 停航航次不再接纳新预约 → 409 route_unavailable。
    const noNew = await call(url("/api/ops/bookings"), {
      method: "POST", token: OPS,
      body: { teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] }
    });
    assert.equal(noNew.status, 409);
    assert.equal(noNew.json.error.code, "route_unavailable");
  } finally { server.close(); }
});

test("强制放行需要双重授权与理由；代金只能领取一次", async () => {
  const { server, url } = await start();
  try {
    const { json: { data: booking } } = await call(url("/api/ops/bookings"), {
      method: "POST", token: OPS, body: { teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] }
    });

    // 缺少第二授权人 → 403。
    const bad = await call(url(`/api/ops/bookings/${booking.id}/force-check-in`), {
      method: "POST", token: OPS,
      body: { authorizerA: "u1", authorizerB: "u1", reason: "x", at: "2026-09-26T08:50:00Z" }
    });
    assert.equal(bad.status, 403);

    // 双授权 + 理由成功。
    const ok = await call(url(`/api/ops/bookings/${booking.id}/force-check-in`), {
      method: "POST", token: OPS,
      body: { authorizerA: "dispatcher-1", authorizerB: "manager-2", reason: "接驳车故障导致迟到，现场核实", at: "2026-09-26T08:50:00Z" }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.status, "confirmed");
  } finally { server.close(); }
});

test("运营端触发事件、结算、恢复与容量审计；重复事件不重复补偿", async () => {
  const { server, url } = await start();
  try {
    const { json: { data: booking } } = await call(url("/api/ops/bookings"), {
      method: "POST", token: OPS, body: { teamId: "G1", sailingId: "N_AM", shares: [{ treeId: "T_A1", kg: 20 }] }
    });
    await call(url(`/api/gate/bookings/${booking.id}/check-in`), { method: "POST", token: GATE, body: {} });

    // 无改派候选（整日关闭）→ 取消并发放代金。
    const e1 = await call(url("/api/ops/events"), {
      method: "POST", token: OPS,
      body: { eventKey: "F", routeId: "R_NORTH", condition: "closed", effectiveAt: "2026-09-26T08:30:00Z" }
    });
    assert.equal(e1.json.data.effects[0].action, "canceled");

    const vouchers = await call(url(`/api/ops/vouchers?bookingId=${booking.id}`), { token: OPS });
    assert.equal(vouchers.json.data.length, 1);
    const voucherId = vouchers.json.data[0].id;

    await call(url("/api/ops/events"), {
      method: "POST", token: OPS,
      body: { eventKey: "F", routeId: "R_NORTH", condition: "closed", effectiveAt: "2026-09-26T08:30:00Z" }
    });
    const vouchersAgain = await call(url(`/api/ops/vouchers?bookingId=${booking.id}`), { token: OPS });
    assert.equal(vouchersAgain.json.data.length, 1, "重复监测不得重复补偿");

    const claim1 = await call(url(`/api/ops/vouchers/${voucherId}/claim`), {
      method: "POST", token: OPS, body: { claimKey: "k-1" }
    });
    assert.equal(claim1.json.data.status, "claimed");
    const claim2 = await call(url(`/api/ops/vouchers/${voucherId}/claim`), {
      method: "POST", token: OPS, body: { claimKey: "k-2" }
    });
    assert.equal(claim2.status, 409);
    assert.equal(claim2.json.error.code, "voucher_already_claimed");

    const audit = await call(url(`/api/ops/audit?capDate=${DATE}`), { token: OPS });
    assert.equal(audit.json.data.ok, true);

    const recover = await call(url("/api/ops/recover"), { method: "POST", token: OPS, body: {} });
    assert.equal(recover.status, 200);
  } finally { server.close(); }
});

test("非法 JSON 返回 400；不存在资源 404", async () => {
  const { server, url } = await start();
  try {
    const res = await fetch(url("/api/ops/teams"), {
      method: "POST",
      headers: { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
      body: "{ not json"
    });
    assert.equal(res.status, 400);
    const nf = await call(url("/api/gate/bookings/nope"), { token: GATE });
    assert.equal(nf.status, 404);
  } finally { server.close(); }
});
