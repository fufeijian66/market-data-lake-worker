// Worker 入口：导出 fetch（HTTP） 与 scheduled（Cron）两个 handler
//
// 注意：使用显式 const + ExportedHandler<Env> 类型声明，避开 `satisfies` + 对象字面量
// 在某些 Wrangler/esbuild 组合下导致的 "Callback returned incorrect type; expected 'Promise'"
// 运行时错误。函数 fetch 不写 async（直接转发已是 Promise 的返回值），更明确。

import type { Env } from './types';
import { handleFetch } from './fetch-handler';
import { runScheduled } from './scheduled-handler';

const worker: ExportedHandler<Env> = {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    // ctx.waitUntil 让 Cron 触发后立即返回，抓取在后台异步完成
    ctx.waitUntil(runScheduled(env));
  },
};

export default worker;
