// Worker 入口：导出 fetch（HTTP） 与 scheduled（Cron）两个 handler

import type { Env } from './types';
import { handleFetch } from './fetch-handler';
import { runScheduled } from './scheduled-handler';

const worker: ExportedHandler<Env> = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  // 直接 await 而不是 ctx.waitUntil，让 Workers runtime 严格等到 runScheduled 完成。
  // ctx.waitUntil 在某些 worker isolate 重用场景下偶发不等到 promise resolve 就回收 isolate，
  // 表现就是 cron 触发了但什么也没发生。await 显式同步等是更稳的写法。
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduled(env);
  },
};

export default worker;
