import { z } from "zod";
import type { Comment, SearchResult } from "../../domain/models";
import type { AppContext } from "../context";
import { latestVideoSnapshots } from "../../storage/snapshots";
import { analyzeSentiment, mineIdeas } from "../../velocity/ideas";
import { defineTool } from "../registry";
import { compactComment, routeMeta, sortComments, truncate } from "./shared";

export const videoCommentsTool = defineTool({
  name: "tt_video_comments",
  risk: "GREEN",
  title: "Video comments",
  summary: "Comments on any public video, sortable by likes, recency or reply count.",
  inputSchema: {
    video_id: z.string().min(1),
    sort: z.enum(["likes", "recent", "replies"]).default("likes"),
    count: z.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  },
  handler: async (input, ctx) => {
    const execution = await ctx.route<SearchResult<Comment>>("comments", {
      video_id: input.video_id,
      count: input.count,
      cursor: input.cursor,
      sort: input.sort,
    });
    const comments = sortComments(execution.value.items, input.sort);
    return {
      summary: `${comments.length} comments on ${input.video_id} via ${execution.provider}, sorted by ${input.sort}.`,
      data: {
        video_id: input.video_id,
        cursor: execution.value.cursor,
        has_more: execution.value.hasMore,
        comments: truncate(comments, input.count).map(compactComment),
      },
      meta: routeMeta(execution),
    };
  },
});

interface IdeaTarget {
  videoId: string;
  username: string | null;
}

async function resolveTargets(
  ctx: AppContext,
  input: {
    video_ids?: string[];
    usernames?: string[];
    per_account_videos: number;
    max_videos: number;
  },
): Promise<{ targets: IdeaTarget[]; ownVideoIds: string[] }> {
  const targets = new Map<string, IdeaTarget>();
  const ownHandle = ctx.ownHandle();
  const ownVideoIds = new Set<string>();

  if (input.video_ids?.length) {
    for (const videoId of input.video_ids) targets.set(videoId, { videoId, username: null });
  }

  const usernames = input.usernames?.length ? input.usernames : [ownHandle];
  for (const raw of usernames) {
    const username = raw.replace(/^@/, "");
    const rows = await latestVideoSnapshots(ctx.env.DB, username, input.per_account_videos);
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.videoId)) continue;
      seen.add(row.videoId);
      targets.set(row.videoId, { videoId: row.videoId, username });
      if (username === ownHandle) ownVideoIds.add(row.videoId);
    }
  }

  return { targets: [...targets.values()].slice(0, input.max_videos), ownVideoIds: [...ownVideoIds] };
}

export const mineCommentIdeasTool = defineTool({
  name: "tt_mine_comment_ideas",
  risk: "GREEN",
  title: "Mine comment ideas",
  summary:
    "Clusters comments across recent own and cohort videos into a ranked content-request backlog ('do Karen next!'), scores demand, and persists it to the content_ideas table.",
  inputSchema: {
    video_ids: z.array(z.string().min(1)).max(50).optional(),
    usernames: z.array(z.string().min(1)).max(25).optional(),
    per_account_videos: z.number().int().min(1).max(20).default(5),
    per_video_comments: z.number().int().min(10).max(200).default(50),
    max_videos: z.number().int().min(1).max(50).default(15),
    limit: z.number().int().min(1).max(100).default(25),
    min_mentions: z.number().int().min(1).max(20).default(2),
    persist: z.boolean().default(true),
  },
  handler: async (input, ctx) => {
    const { targets, ownVideoIds } = await resolveTargets(ctx, input);
    const warnings: string[] = [];
    const comments: Comment[] = [];
    const failures: string[] = [];
    let provider: string | null = null;
    let failover = false;

    for (const target of targets) {
      try {
        const execution = await ctx.route<SearchResult<Comment>>("comments", {
          video_id: target.videoId,
          count: input.per_video_comments,
        });
        provider = execution.provider;
        failover = failover || execution.failover;
        comments.push(...execution.value.items);
      } catch (error) {
        failures.push(`${target.videoId}: ${String(error)}`);
      }
    }

    if (failures.length > 0) {
      warnings.push(`${failures.length}/${targets.length} videos failed to fetch comments.`);
    }
    if (targets.length === 0) {
      warnings.push(
        "No target videos found. Snapshot some videos first (tt_profile, tt_shadow_cohort, or the cron) or pass video_ids explicitly.",
      );
    }

    const ideas = mineIdeas(comments, {
      now: ctx.now,
      limit: input.limit,
      minMentions: input.min_mentions,
      ownVideoIds,
    });

    if (input.persist && ideas.length > 0) {
      const ideaStatements = ideas.map((idea) =>
        ctx.env.DB.prepare(
          `INSERT INTO content_ideas (idea_id, source, payload, status, created_at, demand_score)
           VALUES (?, 'comments', ?, 'backlog', ?, ?)
           ON CONFLICT (idea_id) DO UPDATE SET
             payload = excluded.payload,
             demand_score = excluded.demand_score`,
        ).bind(
          idea.ideaId,
          JSON.stringify({
            concept: idea.concept,
            name_suggestions: idea.nameSuggestions,
            sample_comments: idea.sampleComments,
          }),
          ctx.now,
          idea.demandScore,
        ),
      );
      const evidenceStatements = ideas.flatMap((idea) =>
        idea.evidence.map((evidence) =>
          ctx.env.DB.prepare(
            `INSERT OR IGNORE INTO idea_evidence
               (idea_id, video_id, comment_id, matched_text, digg_count, captured_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            idea.ideaId,
            evidence.videoId,
            evidence.commentId,
            evidence.text.slice(0, 500),
            evidence.likeCount,
            ctx.now,
          ),
        ),
      );
      ctx.snapshot([...ideaStatements, ...evidenceStatements]);
    }

    return {
      summary: `${ideas.length} ranked ideas from ${comments.length} comments across ${targets.length} videos${
        provider ? ` (via ${provider}${failover ? ", after failover" : ""})` : ""
      }.`,
      data: {
        target_videos: targets.map((target) => target.videoId),
        comments_scanned: comments.length,
        ideas: ideas.map((idea) => ({
          idea_id: idea.ideaId,
          concept: idea.concept,
          name_suggestions: idea.nameSuggestions,
          demand_score: idea.demandScore,
          mentions: idea.mentions,
          total_likes: idea.totalLikes,
          sample_comments: idea.sampleComments,
        })),
        persisted: input.persist && ideas.length > 0,
      },
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: provider ?? "d1", source: provider ?? "ventriloquist" },
    };
  },
});

export const commentSentimentTool = defineTool({
  name: "tt_comment_sentiment",
  risk: "GREEN",
  title: "Comment sentiment",
  summary:
    "Aggregate sentiment and top topics for a video or an account's recent videos, with the most-liked positive and negative examples.",
  inputSchema: {
    video_id: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    max_videos: z.number().int().min(1).max(20).default(5),
    per_video_comments: z.number().int().min(10).max(200).default(50),
  },
  handler: async (input, ctx) => {
    if (!input.video_id && !input.username) {
      throw new Error("provide either video_id or username");
    }
    const warnings: string[] = [];
    const videoIds: string[] = [];

    if (input.video_id) videoIds.push(input.video_id);
    if (input.username) {
      const username = input.username.replace(/^@/, "");
      const rows = await latestVideoSnapshots(ctx.env.DB, username, input.max_videos);
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.videoId)) continue;
        seen.add(row.videoId);
        videoIds.push(row.videoId);
      }
      if (videoIds.length === 0) {
        warnings.push(`No snapshotted videos for @${username}; call tt_profile first.`);
      }
    }

    const comments: Comment[] = [];
    for (const videoId of videoIds.slice(0, input.max_videos)) {
      try {
        const execution = await ctx.route<SearchResult<Comment>>("comments", {
          video_id: videoId,
          count: input.per_video_comments,
        });
        comments.push(...execution.value.items);
      } catch (error) {
        warnings.push(`${videoId}: ${String(error)}`);
      }
    }

    const bucket = analyzeSentiment(comments);
    const positive = sortComments(
      comments.filter((comment) => (comment.likeCount ?? 0) > 0),
      "likes",
    )
      .filter((comment) => analyzeSentiment([comment]).positive > 0)
      .slice(0, 5);
    const negative = sortComments(comments, "likes")
      .filter((comment) => analyzeSentiment([comment]).negative > 0)
      .slice(0, 5);

    return {
      summary: `${comments.length} comments across ${videoIds.length} videos: ${bucket.positive} positive, ${bucket.negative} negative, ${bucket.neutral} neutral (score ${bucket.score}).`,
      data: {
        videos_analyzed: videoIds.length,
        comments_analyzed: comments.length,
        sentiment: {
          positive: bucket.positive,
          negative: bucket.negative,
          neutral: bucket.neutral,
          score: bucket.score,
        },
        top_topics: bucket.topTopics,
        top_positive: positive.map(compactComment),
        top_negative: negative.map(compactComment),
      },
      warnings: warnings.length ? warnings : undefined,
      meta: { provider: "d1", source: "ventriloquist" },
    };
  },
});
