// Worker 入口：导出 fetch（HTTP） 与 scheduled（Cron）两个 handler

import type { Env } from './types';
import { handleFetch } from './fetch-handler';
import { runScheduled } from './scheduled-handler';

const worker: ExportedHandler<Env> = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    // ctx.waitUntil 让 Cron 触发后立即返回，抓取在后台异步完成
    ctx.waitUntil(runScheduled(env));
  },
};

export default worker;
