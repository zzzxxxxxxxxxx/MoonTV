/* eslint-disable @typescript-eslint/ban-ts-comment, no-console */

// 复用 opennextjs-cloudflare 生成的 fetch handler，并额外提供 scheduled handler
// 以支持 Cloudflare Cron Triggers（`opennextjs-cloudflare build` 时生成该文件）
// @ts-ignore .open-next/worker.js 是构建产物，类型检查时不存在
import { default as handler } from './.open-next/worker.js';

interface WorkerEnv {
  DB: unknown;
  ASSETS: unknown;
}

const worker = {
  fetch: handler.fetch,

  // Cron Triggers 触发时内部调用 /api/cron，等价于原 Vercel Cron 的行为
  async scheduled(_controller: unknown, env: WorkerEnv, ctx: unknown) {
    try {
      const response = await handler.fetch(
        new Request('https://moontv.internal/api/cron'),
        env,
        ctx
      );
      console.log('[cron] /api/cron ->', response.status);
    } catch (error) {
      console.error('[cron] failed:', error);
    }
  },
};

export default worker;
