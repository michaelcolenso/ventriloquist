import { createLogger, type Logger } from "./logger";

export interface AlertEnv {
  ALERT_TELEGRAM_BOT_TOKEN?: string;
  ALERT_TELEGRAM_CHAT_ID?: string;
}

export interface AlertOptions {
  fetcher?: typeof fetch;
  logger?: Logger;
}

/**
 * Operator alerting (spec 7.4: "two consecutive failures -> alert fires").
 *
 * Alerts are best-effort by design: a failing Telegram call must never break
 * a cron run or a job callback. When the channel is unconfigured the alert is
 * logged and dropped, so local development stays silent without special-casing.
 */
export async function sendAlert(
  env: AlertEnv,
  text: string,
  options: AlertOptions = {},
): Promise<boolean> {
  const logger = options.logger ?? createLogger("info", { component: "alerts" });
  const token = env.ALERT_TELEGRAM_BOT_TOKEN;
  const chatId = env.ALERT_TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logger.warn("alert suppressed: Telegram is not configured", { text });
    return false;
  }

  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `[ventriloquist] ${text}`,
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      logger.error("alert delivery failed", { status: response.status, text });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("alert delivery threw", { error: String(error), text });
    return false;
  }
}
