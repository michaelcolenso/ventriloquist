/**
 * Comment mining (spec 4.3 / "the ideation engine").
 *
 * Clustering is deliberately deterministic and dependency-free: reject-stopwords
 * -> score phrases -> bucket comments by the strongest phrase. It runs on the
 * Worker, costs nothing, and produces a backlog a human can read. Swap in
 * embeddings later without changing the tool contract.
 */

import type { Comment } from "../domain/models";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "doing", "have",
  "has", "had", "having", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
  "them", "my", "your", "his", "its", "our", "their", "mine", "yours", "to", "of", "in", "on",
  "for", "with", "about", "as", "at", "by", "from", "into", "like", "so", "not", "no", "yes",
  "please", "pls", "plz", "can", "could", "would", "should", "will", "just", "really", "very",
  "how", "what", "when", "where", "who", "why", "which", "there", "here", "get", "got", "make",
  "made", "one", "two", "also", "more", "most", "some", "any", "all", "every", "your", "youre",
  "im", "ive", "dont", "doesnt", "didnt", "cant", "wont", "lol", "omg", "please", "video",
  "videos", "comment", "comments", "tiktok", "fyp", "virall", "viral", "part", "next", "now",
]);

/** Words that signal an explicit content request. */
const REQUEST_MARKERS = [
  "do ",
  "make ",
  "please",
  "pls",
  "plz",
  "need ",
  "want ",
  "next",
  "part 2",
  "part two",
  "can you",
  "could you",
  "i beg",
  "begging",
  "series",
  "cover",
  "where is",
  "what about",
];

const NAME_PATTERN = /\b([A-Z][a-z]{2,15})\b/g;

export interface MinedIdea {
  ideaId: string;
  concept: string;
  nameSuggestions: string[];
  demandScore: number;
  mentions: number;
  totalLikes: number;
  sampleComments: string[];
  evidence: { commentId: string; videoId: string | null; text: string; likeCount: number | null }[];
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/** Proper-noun-style name suggestions ("do Karen next!" -> ["Karen"]). */
export function extractNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(NAME_PATTERN)) {
    const candidate = match[1]!;
    if (STOPWORDS.has(candidate.toLowerCase())) continue;
    names.add(candidate);
  }
  return [...names];
}

function isRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return REQUEST_MARKERS.some((marker) => lower.includes(marker));
}

function conceptFor(comment: Comment): { concept: string; names: string[] } | null {
  const names = extractNames(comment.text);
  const tokens = tokenize(comment.text);
  const request = isRequest(comment.text);

  if (names.length > 0 && (request || comment.likeCount !== null)) {
    return { concept: names[0]!.toLowerCase(), names };
  }
  if (request && tokens.length > 0) {
    return { concept: tokens.slice(0, 3).join(" "), names };
  }
  if (tokens.length > 0 && tokens[0]!.length >= 4) {
    return { concept: tokens.slice(0, 2).join(" "), names };
  }
  return null;
}

export interface MineOptions {
  now: number;
  limit?: number;
  minMentions?: number;
  /** Comments from the account's own videos weigh more than cohort noise. */
  ownVideoIds?: string[];
}

export function mineIdeas(comments: Comment[], options: MineOptions): MinedIdea[] {
  const own = new Set(options.ownVideoIds ?? []);
  const clusters = new Map<
    string,
    {
      concept: string;
      names: Set<string>;
      comments: Comment[];
      totalLikes: number;
      ownCount: number;
    }
  >();

  for (const comment of comments) {
    if (!comment.text || comment.text.trim().length < 4) continue;
    const extracted = conceptFor(comment);
    if (!extracted) continue;
    const bucket = clusters.get(extracted.concept) ?? {
      concept: extracted.concept,
      names: new Set<string>(),
      comments: [],
      totalLikes: 0,
      ownCount: 0,
    };
    bucket.comments.push(comment);
    bucket.totalLikes += comment.likeCount ?? 0;
    for (const name of extracted.names) bucket.names.add(name);
    if (comment.videoId && own.has(comment.videoId)) bucket.ownCount += 1;
    clusters.set(extracted.concept, bucket);
  }

  const minMentions = options.minMentions ?? 2;
  const ideas = [...clusters.values()]
    .filter((bucket) => bucket.comments.length >= minMentions)
    .map((bucket) => {
      const mentions = bucket.comments.length;
      const requestBonus = bucket.comments.filter((comment) => isRequest(comment.text)).length;
      const demandScore =
        (bucket.totalLikes + 1) *
        Math.log2(1 + mentions) *
        (1 + requestBonus / mentions) *
        (1 + bucket.ownCount / mentions);
      return {
        ideaId: `idea_${slug(bucket.concept)}`,
        concept: bucket.concept,
        nameSuggestions: [...bucket.names].slice(0, 10),
        demandScore: Math.round(demandScore * 100) / 100,
        mentions,
        totalLikes: bucket.totalLikes,
        sampleComments: bucket.comments
          .slice()
          .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
          .slice(0, 5)
          .map((comment) => comment.text),
        evidence: bucket.comments.map((comment) => ({
          commentId: comment.id,
          videoId: comment.videoId,
          text: comment.text,
          likeCount: comment.likeCount,
        })),
      };
    })
    .sort((a, b) => b.demandScore - a.demandScore);

  return ideas.slice(0, options.limit ?? 25);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "idea"
  );
}

const POSITIVE = new Set([
  "love", "loves", "loved", "amazing", "great", "best", "beautiful", "perfect", "thanks",
  "thank", "awesome", "good", "nice", "obsessed", "favorite", "favourite", "hilarious",
  "funny", "iconic", "cute", "brilliant", "excellent", "wonderful", "goat", "slay",
  "accurate", "helpful", "useful", "interesting", "fascinating",
]);

const NEGATIVE = new Set([
  "hate", "hated", "awful", "bad", "terrible", "worst", "wrong", "ugly", "boring", "cringe",
  "confusing", "annoying", "stupid", "dumb", "useless", "trash", "mid", "disappointed",
  "missed", "incorrect", "problem", "issue", "broken", "meh", "unfollow",
]);

const NEGATORS = new Set(["not", "no", "never", "dont", "doesnt", "didnt", "isnt", "arent", "cant", "wont"]);

export interface SentimentBucket {
  positive: number;
  negative: number;
  neutral: number;
  score: number;
  topTopics: { topic: string; count: number }[];
}

export function analyzeSentiment(comments: Comment[], limit = 15): SentimentBucket {
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  const topics = new Map<string, number>();

  for (const comment of comments) {
    const tokens = comment.text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
    let score = 0;
    let negated = false;
    for (const token of tokens) {
      if (NEGATORS.has(token)) {
        negated = true;
        continue;
      }
      if (POSITIVE.has(token)) score += negated ? -1 : 1;
      else if (NEGATIVE.has(token)) score += negated ? 1 : -1;
      negated = false;
    }
    if (score > 0) positive += 1;
    else if (score < 0) negative += 1;
    else neutral += 1;

    for (const token of tokenize(comment.text)) {
      topics.set(token, (topics.get(token) ?? 0) + 1);
    }
  }

  const total = Math.max(1, positive + negative + neutral);
  return {
    positive,
    negative,
    neutral,
    score: Math.round(((positive - negative) / total) * 1000) / 1000,
    topTopics: [...topics.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([topic, count]) => ({ topic, count })),
  };
}
