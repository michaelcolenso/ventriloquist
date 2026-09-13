import type { Env } from "./env";
import { handleRequest } from "./http/router";
import { runCron } from "./cron";
import { consumeQueue, handleJobCallback } from "./jobs/consumer";
import type { PostJobMessage } from "./storage/jobs";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin/job-callback" && request.method === "POST") {
      return handleJobCallback(request, env);
    }
    return handleRequest(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return runCron(controller.cron, env, ctx);
  },

  async queue(batch: MessageBatch<PostJobMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    return consumeQueue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env, PostJobMessage>;
