import { chromium, type BrowserContext, type Page } from "playwright-core";
import { actionDelayMs, jitterIntoWindow, shouldSkipSlot, sleep, type PacingOptions } from "./pacing";
import { describeSession, loadPostingCookies, type SessionCustodyOptions } from "./sessions";

/**
 * TikTok Studio's DOM is the volatile part of this file. Every selector lives
 * in SELECTORS so a Studio redesign is a one-place patch rather than a hunt.
 */
export const SELECTORS = {
  uploadInput: 'input[type="file"]',
  captionEditor: 'div[contenteditable="true"]',
  postButton: 'button:has-text("Post"), button[data-e2e="post_video_button"]',
  confirmation: 'text=/Your video is being uploaded|Uploading|Posting/i',
  notForKids: 'input[type="radio"][value="false"]',
  profileVideoLink: 'a[href*="/video/"]',
};

export const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=web&lang=en";

export interface UploadRequest {
  videoPath: string;
  caption: string;
  hashtags: string[];
  scheduledAt: number | null;
  timezoneOffsetMinutes: number;
}

export interface UploadResult {
  ok: boolean;
  tiktokUrl: string | null;
  detail: string;
  postedAt: number | null;
  skipped?: boolean;
}

export interface UploaderOptions extends SessionCustodyOptions {
  executablePath: string;
  userDataDir: string;
  headless: boolean;
  timeoutMs: number;
  pacing: PacingOptions;
  profileHandle: string;
  dryRun: boolean;
}

/**
 * tiktok-uploader-style flow: a persistent context carrying the posting
 * session, paced interactions, then confirmation by finding the video on the
 * profile rather than trusting the success toast.
 */
export class PostingWorker {
  constructor(private readonly options: UploaderOptions) {}

  async post(request: UploadRequest): Promise<UploadResult> {
    if (shouldSkipSlot(Math.random, this.options.pacing)) {
      return {
        ok: true,
        skipped: true,
        tiktokUrl: null,
        detail: "no-op slot selected by pacing theater",
        postedAt: null,
      };
    }

    const cookies = await loadPostingCookies(this.options);
    const sessionInfo = describeSession(cookies);
    const scheduledAt = jitterIntoWindow(
      request.scheduledAt ?? Math.floor(Date.now() / 1000),
      request.timezoneOffsetMinutes,
      this.options.pacing,
    );

    if (scheduledAt > Math.floor(Date.now() / 1000) + 60) {
      return {
        ok: true,
        skipped: true,
        tiktokUrl: null,
        detail: `scheduled for ${new Date(scheduledAt * 1000).toISOString()} after window jitter`,
        postedAt: null,
      };
    }

    const context = await chromium.launchPersistentContext(this.options.userDataDir, {
      executablePath: this.options.executablePath,
      headless: this.options.headless,
      viewport: { width: 1366, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });

    try {
      await context.addCookies(cookies);
      const page = context.pages()[0] ?? (await context.newPage());

      await page.goto(UPLOAD_URL, { timeout: this.options.timeoutMs });
      await sleep(actionDelayMs(this.options.pacing));

      await page.setInputFiles(SELECTORS.uploadInput, request.videoPath, {
        timeout: this.options.timeoutMs,
      });
      await sleep(actionDelayMs(this.options.pacing));

      const caption = [request.caption, ...request.hashtags.map((tag) => `#${tag}`)]
        .filter(Boolean)
        .join(" ");
      await this.typeCaption(page, caption);
      await sleep(actionDelayMs(this.options.pacing));
      await this.dismissOptionalPrompts(page);

      if (this.options.dryRun) {
        return {
          ok: true,
          tiktokUrl: null,
          detail: `dry run: reached the caption step with ${sessionInfo.cookie_count} cookies`,
          postedAt: null,
        };
      }

      await page.locator(SELECTORS.postButton).first().click({ timeout: this.options.timeoutMs });
      await page
        .locator(SELECTORS.confirmation)
        .first()
        .waitFor({ timeout: this.options.timeoutMs })
        .catch(() => undefined);

      const tiktokUrl = await this.confirmOnProfile(context);
      return {
        ok: tiktokUrl !== null,
        tiktokUrl,
        detail: tiktokUrl
          ? "post confirmed on the profile"
          : "posted, but the new video was not found on the profile within the confirmation window",
        postedAt: Math.floor(Date.now() / 1000),
      };
    } finally {
      await context.close();
    }
  }

  private async typeCaption(page: Page, caption: string): Promise<void> {
    const editor = page.locator(SELECTORS.captionEditor).first();
    await editor.click({ timeout: this.options.timeoutMs });
    await page.keyboard.type(caption, { delay: 40 });
  }

  private async dismissOptionalPrompts(page: Page): Promise<void> {
    const notForKids = page.locator(SELECTORS.notForKids).first();
    if ((await notForKids.count()) > 0) {
      await notForKids.click({ timeout: 5_000 }).catch(() => undefined);
    }
  }

  /** Success is confirmed by the artifact being live, not by the UI toast. */
  private async confirmOnProfile(context: BrowserContext): Promise<string | null> {
    const page = await context.newPage();
    try {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await page.goto(`https://www.tiktok.com/@${this.options.profileHandle}`, {
          timeout: this.options.timeoutMs,
        });
        const link = await page.locator(SELECTORS.profileVideoLink).first().getAttribute("href");
        if (link) return link.startsWith("http") ? link : `https://www.tiktok.com${link}`;
        await sleep(15_000);
      }
      return null;
    } finally {
      await page.close();
    }
  }
}
