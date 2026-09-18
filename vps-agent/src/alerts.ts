import type { FastifyBaseLogger } from "fastify";

export interface AlertEnv {
  ALERT_TELEGRAM_BOT_TOKEN?: string;
  ALERT_TELEGRAM_CHAT_ID?: string;
}

export type AlertSender = (text: string) => Promise<boolean>;

/**
 * Telegram operator alerts. Delivery is best-effort: a failed alert must not
 * fail the job or endpoint that raised it.
 */
export function createAlertSender(
  env: AlertEnv,
  logger: FastifyBaseLogger,
  fetcher: typeof fetch = fetch,
): AlertSender {
  const token = env.ALERT_TELEGRAM_BOT_TOKEN;
  const chatId = env.ALERT_TELEGRAM_CHAT_ID;

  return async (text: string): Promise<boolean> => {
    if (!token || !chatId) {
      logger.warn({ text }, "alert suppressed: Telegram is not configured");
      return false;
    }
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `[ventriloquist/vps] ${text}`,
          disable_web_page_preview: true,
        }),
      });
      if (!response.ok) {
        logger.error({ status: response.status, text }, "alert delivery failed");
        return false;
      }
      return true;
    } catch (error) {
      logger.error({ error: String(error), text }, "alert delivery threw");
      return false;
    }
  };
}
