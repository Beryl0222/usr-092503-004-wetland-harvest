/**
 * 服务入口：启动时执行 recover()，继续当天未结流程；
 * 之后按固定间隔扫描到期名额（以注入时钟为准，跨日同样准确）。
 */
import { createServer } from "node:http";
import { Clock } from "./engine.js";
import { createApp, createEngine } from "./api.js";

export function startServer(opts = {}) {
  const clock = opts.clock ?? new Clock();
  const engine = createEngine({ ...opts, clock });
  const app = createApp(engine);
  const server = createServer(app);

  // 服务恢复：释放已到期名额、按最新环境事件重算未结行程
  const recovery = engine.recover();

  // 定时扫描：即便没有外部调用，到期名额也会被释放
  const sweepMs = opts.sweepMs ?? 30_000;
  const timer = setInterval(() => {
    try {
      engine.releaseDueNoShows();
    } catch (e) {
      console.error("noshow sweep failed:", e.message);
    }
  }, sweepMs);
  timer.unref?.();

  server.listen(opts.port ?? Number(process.env.PORT ?? 8080), opts.host ?? "127.0.0.1");
  return { server, engine, timer, recovery };
}

// 直接执行：node src/server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, recovery } = startServer();
  console.log(JSON.stringify({
    msg: "wetland harvest scheduler started",
    port: server.address()?.port,
    db: process.env.WETLAND_DB ?? ":memory:",
    recovery
  }));
}
