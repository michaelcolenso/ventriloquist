import type { Comment, Video } from "../../domain/models";
import type { AppContext } from "../context";
import type { SourceName } from "../../types";

export interface CompactVideo {
  video_id: string;
  url: string | null;
  description: string | null;
  created_at: number | null;
  duration_seconds: number | null;
  author: string | null;
  author_id: string | null;
  verified: boolean;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  hashtags: string[];
  sound_id: string | null;
  sound_title: string | null;
  is_slideshow: boolean;
  source: SourceName;
}

export function compactVideo(video: Video): CompactVideo {
  return {
    video_id: video.id,
    url: video.url,
    description: video.description,
    created_at: video.createdAt,
    duration_seconds: video.durationSeconds,
    author: video.author?.uniqueId ?? null,
    author_id: video.author?.id ?? null,
    verified: video.author?.verified ?? false,
    plays: video.stats.playCount,
    likes: video.stats.likeCount,
    comments: video.stats.commentCount,
    shares: video.stats.shareCount,
    hashtags: video.hashtags,
    sound_id: video.music?.id ?? null,
    sound_title: video.music?.title ?? null,
    is_slideshow: video.isSlideshow,
    source: video.source,
  };
}

export interface CompactComment {
  comment_id: string;
  video_id: string | null;
  text: string;
  likes: number | null;
  replies: number | null;
  created_at: number | null;
  author: string | null;
  liked_by_author: boolean;
}

export function compactComment(comment: Comment): CompactComment {
  return {
    comment_id: comment.id,
    video_id: comment.videoId,
    text: comment.text,
    likes: comment.likeCount,
    replies: comment.replyCount,
    created_at: comment.createdAt,
    author: comment.author?.uniqueId ?? null,
    liked_by_author: comment.likedByAuthor,
  };
}

export function sortComments(
  comments: Comment[],
  sort: "likes" | "recent" | "replies",
): Comment[] {
  const sorted = [...comments];
  if (sort === "likes") sorted.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));
  else if (sort === "replies") sorted.sort((a, b) => (b.replyCount ?? 0) - (a.replyCount ?? 0));
  else sorted.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return sorted;
}

export function routeMeta(execution: {
  provider: string;
  source: SourceName;
  attemptChain: string[];
  failover: boolean;
  latencyMs: number;
  costUsd: number;
}): Record<string, unknown> {
  return {
    provider: execution.provider,
    source: execution.source,
    failover: execution.failover,
    attempt_chain: execution.attemptChain,
    latency_ms: execution.latencyMs,
    cost_usd: execution.costUsd,
  };
}

export function truncate<T>(items: T[], limit: number): T[] {
  return items.slice(0, Math.max(0, limit));
}

export function numbersOnly(values: (number | null)[]): number[] {
  return values.filter((value): value is number => typeof value === "number");
}
