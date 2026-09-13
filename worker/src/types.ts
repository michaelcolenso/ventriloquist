/**
 * Risk is a first-class type (spec P4).
 *
 * GREEN  scraped public data - no session, no account exposure
 * AMBER  session-authenticated reads - cookie exposure, soft-ban risk
 * RED    write actions - account penalty risk
 */
export type RiskTier = "GREEN" | "AMBER" | "RED";

export const RISK_LABEL: Record<RiskTier, string> = {
  GREEN: "GREEN · scraped-public",
  AMBER: "AMBER · session-authenticated",
  RED: "RED · write-action",
};

/** Backend-routable read capabilities (spec section 6). */
export type Capability =
  | "trending"
  | "hashtag_stats"
  | "hashtag_videos"
  | "sound_stats"
  | "search"
  | "profile"
  | "profile_videos"
  | "video_detail"
  | "comments"
  | "transcript"
  | "download";

export const ALL_CAPABILITIES: Capability[] = [
  "trending",
  "hashtag_stats",
  "hashtag_videos",
  "sound_stats",
  "search",
  "profile",
  "profile_videos",
  "video_detail",
  "comments",
  "transcript",
  "download",
];

export type Outcome =
  | "success"
  | "failure"
  | "skipped_circuit_open"
  | "skipped_budget";

export type ProviderName = "signer" | "creative_center" | "scrapebadger" | "scrapecreators";

export type SourceName = "signer" | "scrapebadger" | "scrapecreators" | "creative_center";
