# 湿地火柿采收承载调度引擎

湿地公园火柿季的服务端调度引擎。把**树木成熟度（当日可摘果量）、地块保育上限、船只载荷、
船员资质、航线时段**作为统一资源，在团队到场确认时**原子占用**采收份额并生成行程；
未按时到场释放名额；环境监测事件（可能迟到或重复）按**有效时间**重算受影响行程，
把团队分别送入**避险 / 改派 / 结算**流程。

零运行时依赖，仅使用 Node.js 22 内置的 `node:sqlite` 与 `node:http`。

## 它解决的老问题

| 旧痛点 | 本系统的保证 |
| --- | --- |
| 同一棵树被多组同时分配 | 写事务互斥 + 占用合计 + 唯一索引，数据库层杜绝超卖 |
| 停航后仍放行 | 航次状态纳入到场校验；闸机对关闭航次放行返回 `409` |
| 补偿额度重复发放 | 代金 `(名额, 事件)` 唯一；事件 `event_key` 幂等去重 |
| 迟到/重复监测 | 按 `effective_at` 重放；重复上报直接去重返回首次结果 |
| 改派突破总采收上限 | 改派保持确认千克数与逐树份额不变，只迁移名额/船载 |
| 人工违规强制放行 | 必须两个**不同**授权人 + 非空理由，审批留痕 |
| 宕机后流程中断 | 所有占用/状态/事件持久化；`recover` 续跑当天未结流程 |

## 运行

```bash
npm test     # 24 个自动化场景（含 worker_threads 真并发）
npm run build
PORT=8080 DB_PATH=wetland.db GATE_TOKEN=... OPS_TOKEN=... node src/server.js
```

时钟可注入（用于日终结算与恢复的确定性运行）：`FIXED_CLOCK_ISO=2026-09-26T06:00:00Z`。

## 资源模型与统一占用

所有资源占用落在同一张 `occupancy` 表（`active=1` 生效，释放时置 0 并留原因/时间）：

- `tree`：某棵树某日被占千克；上限取 `tree_capacity.available_kg`（成熟度）。
- `plot` 上限不单独占用——**地块占用 = 其下所有树的 tree 占用之和**，对照 `plots.daily_cap_kg`（保育上限）。
- `boat`：某航次船只被占千克，对照 `boats.payload_kg`。
- `slot`：某航次队伍名额（每条占 1），对照 `sailings.team_capacity`。

部分唯一索引 `uq_occ_active` 保证「同一名额对同一资源至多一条生效占用」，
重复到场/重复扣减在**数据库约束层**失败，而不是依赖先查后插的时序。

## 并发正确性

- SQLite `WAL` + `busy_timeout`，所有写操作在 `BEGIN IMMEDIATE` 事务中执行，
  文件写锁把并发到场串行化；抢不到锁的连接退避重试并重新读取最新容量。
- 容量不足抛错 → 整个事务回滚，绝不留下部分占用（候补团队「要么全额满足、要么不占」）。
- `test/concurrency.test.js` 用 **8 个 worker 线程各自独立连接同一个库文件**，
  在屏障处同时确认 10 组候补：紧俏份额下恰有 1 组成功、名额/船载受限下恰有 2 组成功，
  且独立连接审计零违规。

## 名额生命周期

```
reserved / waitlisted
   │ check-in（截止前；候补此刻原子抢占）
   ▼
confirmed ──board──▶ boarded ──complete──▶ completed ──settle──▶ settled
   │                   │  ▲                    │
   │ 停航(未登船)       │  │ reboard(复航)       │ 停航(迟到事件)
   ▼                   ▼  │                    ▼
reassigned ───────▶ sheltering            即时结算
   │ 无候选
   ▼
event_canceled（发一次性代金）

reserved/waitlisted ──逾期未到场──▶ expired / no_show_canceled（释放占用）
reserved/waitlisted ──停航前未确认─▶ event_canceled（无代金，尚无既得权益）
```

到场截止 = 航次出发时刻 − `grace_minutes`（默认 20 分钟），比较绝对时刻，**跨日释放准确**。

## 环境监测事件

`POST /api/ops/events`，字段 `eventKey / routeId / condition / effectiveAt / observedAt? / reopenAt?`。

- **幂等**：相同 `eventKey` 重复上报返回 `{deduplicated:true}` 与首次效应，不重复补偿。
- **迟到**：可在事件生效之后才送达；按 `effectiveAt` 时刻名额的真实状态分流。
- **停航窗口** `[effectiveAt, reopenAt)`：只影响与之时间重叠的航次；
  复航后才出发的航次保持开放并作为改派目标。不给 `reopenAt` 表示关闭当日剩余航次。
- 分流：**已登船 → 避险**（复航后可重新登船）；**已完成 → 结算**；
  **已确认未登船 → 改派**（候选按出发时刻、ID 确定序，重放结果稳定），无候选则取消发代金；
  **未确认 → 取消**且不补偿。

代金：金额 = 确认千克 × `voucherPerKg`；`(booking_id,event_key)` 唯一保证一次事件只发一张；
领取需 `claimKey`，重复领取返回 `409 voucher_already_claimed`。

## 人工强制放行

`POST /api/ops/bookings/:id/force-check-in`，必须提供 `authorizerA`、`authorizerB`
（两个**不同**的授权人工号）与非空 `reason`；审批写入 `approvals` 并记审计日志后，
才在同一事务内执行确认。任一条件不满足返回 `403`。

## 日终结算与容量审计（时钟可注入）

- `POST /api/ops/settlement {capDate}`：结算当日所有已完成名额（实采千克 × `pricePerKg`）。
  结算单以 `booking_id` 为主键，**幂等**，重复执行/重启恢复不重复付款；避险中未完成不结算。
  返回值内含当日容量审计。
- `GET /api/ops/audit?capDate=...`：逐项给出树/地块/船/名额的 `used/cap/remaining`
  与 `violations`，`ok:true` 表示无任何超卖。
- `POST /api/ops/recover`：服务重启后续跑——释放逾期名额、补结算已完成未付款名额、
  对仍挂在关闭航次上的名额按关闭事件再尝试改派/取消（全部幂等）。

## JSON API

鉴权：`Authorization: Bearer <token>`，分 `gate`（闸机端）与 `ops`（运营端）两个角色。
响应统一为 `{ok:true,data}` 或 `{ok:false,error:{code,message,details}}`。

**闸机端**
- `POST /api/gate/walk-in`
- `POST /api/gate/bookings/:id/check-in`
- `POST /api/gate/bookings/:id/board`
- `POST /api/gate/bookings/:id/complete`
- `GET  /api/gate/bookings/:id`

**运营端**
- 建档：`plots` / `trees` / `tree-capacity` / `boats` / `crew` / `routes` / `sailings` / `teams`（均 `POST`）
- `POST /api/ops/bookings`、`GET /api/ops/bookings?capDate=&status=`、`GET /api/ops/bookings/:id`
- `POST /api/ops/events`
- `POST /api/ops/bookings/:id/force-check-in`
- `GET  /api/ops/vouchers`、`POST /api/ops/vouchers/:id/claim`
- `POST /api/ops/release-expired`、`POST /api/ops/settlement`、`POST /api/ops/recover`
- `GET  /api/ops/audit?capDate=`

错误码：`validation_failed(400)`、`unauthorized(401/403)`、`not_found(404)`、
`state_conflict(409)`、`past_deadline(409)`、`route_unavailable(409)`、
`capacity_exhausted(409)`、`voucher_already_claimed(409)`。

## 代码结构

```
src/
  index.js   领域契约（ResourceKind/RouteCondition/normalizeQuota）与导出
  db.js      SQLite 连接、迁移与全部表结构/约束
  engine.js  调度引擎：占用、到场、事件分流、改派、代金、审批、结算、恢复、审计
  api.js     JSON HTTP 处理器与角色鉴权
  server.js  装配与服务入口（可注入时钟）
  clock.js   可注入/可推进时钟
  errors.js  稳定错误码
test/
  engine.unit.test.js    容量约束、状态机、资质、双重授权
  concurrency.test.js    worker_threads 真并发不超卖
  events.test.js         迟到/重复事件、避险/改派/结算、代金幂等、停航窗口
  lifecycle.test.js      跨日释放、日终结算幂等、宕机恢复
  api.test.js            HTTP 全链路、角色鉴权、错误码
```

所有资源占用与状态变更都写入 `change_log`，名额状态每次迁移写入 `booking_timeline`，
改派历史在 `reassignments` / `itineraries`（行程按版本留存）中可追溯。
