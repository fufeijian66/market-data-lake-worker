// Worker 入口：导出 fetch（HTTP） 与 scheduled（Cron）两个 handler

import type { Env } from './types';
import { handleFetch } from './fetch-handler';
import { runScheduled } from './scheduled-handler';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleFetch(req, env);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // ctx.waitUntil 让 Cron 触发后立即返回，抓取在后台异步完成
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
