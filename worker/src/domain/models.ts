import type { SourceName } from "../types";

export interface AuthorSummary {
  id: string | null;
  uniqueId: string | null;
  nickname: string | null;
  verified: boolean;
  avatarUrl: string | null;
  signature: string | null;
  followerCount: number | null;
  videoCount: number | null;
  region: string | null;
}

export interface MusicRef {
  id: string | null;
  title: string | null;
  author: string | null;
  original: boolean;
  durationSeconds: number | null;
  videoCount: number | null;
  userCount: number | null;
  playUrl: string | null;
}

export interface VideoStats {
  playCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  collectCount: number | null;
}

export interface Video {
  id: string;
  description: string | null;
  createdAt: number | null;
  url: string | null;
  shareUrl: string | null;
  durationSeconds: number | null;
  coverUrl: string | null;
  region: string | null;
  author: AuthorSummary | null;
  music: MusicRef | null;
  stats: VideoStats;
  hashtags: string[];
  isSlideshow: boolean;
  source: SourceName;
}

export interface Profile {
  id: string | null;
  uniqueId: string | null;
  nickname: string | null;
  signature: string | null;
  verified: boolean;
  privateAccount: boolean;
  avatarUrl: string | null;
  region: string | null;
  profileUrl: string | null;
  stats: {
    followerCount: number | null;
    followingCount: number | null;
    heartCount: number | null;
    videoCount: number | null;
  };
  source: SourceName;
}

export interface VideoDetail {
  video: Video;
  /** Non-null only when a transcript path ran (lazy Whisper / vendor ASR). */
  transcript: TranscriptResult | null;
}

export interface Comment {
  id: string;
  videoId: string | null;
  parentCommentId: string | null;
  text: string;
  likeCount: number | null;
  replyCount: number | null;
  createdAt: number | null;
  likedByAuthor: boolean;
  author: AuthorSummary | null;
  source: SourceName;
}

export interface HashtagStats {
  id: string | null;
  name: string;
  description: string | null;
  videoCount: number | null;
  viewCount: number | null;
  url: string | null;
  source: SourceName;
}

export interface SoundStats {
  id: string | null;
  title: string | null;
  author: string | null;
  original: boolean;
  durationSeconds: number | null;
  videoCount: number | null;
  userCount: number | null;
  coverUrl: string | null;
  playUrl: string | null;
  source: SourceName;
}

/** Creative Center / ScrapeBadger trending hashtag row, normalized. */
export interface TrendingHashtag {
  name: string;
  id: string | null;
  rank: number | null;
  rankDiff: number | null;
  countryCode: string | null;
  industry: string | null;
  publishCount: number | null;
  viewCount: number | null;
  userCount: number | null;
  isPromoted: boolean;
  isNew: boolean;
  url: string | null;
  source: SourceName;
}

export interface TrendingSound {
  id: string | null;
  title: string | null;
  author: string | null;
  rank: number | null;
  rankDiff: number | null;
  countryCode: string | null;
  durationSeconds: number | null;
  userCount: number | null;
  coverUrl: string | null;
  playUrl: string | null;
  isNew: boolean;
  link: string | null;
  source: SourceName;
}

export interface TranscriptResult {
  text: string;
  language: string | null;
  source: "whisper" | "tiktok_caption" | "scrapebadger";
}

export interface SearchResult<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
  region: string | null;
  source: SourceName;
}

export function emptyVideoStats(): VideoStats {
  return {
    playCount: null,
    likeCount: null,
    commentCount: null,
    shareCount: null,
    collectCount: null,
  };
}
