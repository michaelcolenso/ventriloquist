import type { Env } from "./env";
import { handleRequest } from "./http/router";
import { runCron } from "./cron";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return runCron(controller.cron, env, ctx);
  },
} satisfies ExportedHandler<Env>;
