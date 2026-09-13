import { describe, expect, it } from "vitest";
import { analyzeSentiment, extractNames, mineIdeas, tokenize } from "../src/velocity/ideas";
import type { Comment } from "../src/domain/models";

let counter = 0;
function comment(text: string, options: { likes?: number; videoId?: string; id?: string } = {}): Comment {
  counter += 1;
  return {
    id: options.id ?? `c${counter}`,
    videoId: options.videoId ?? "video-1",
    parentCommentId: null,
    text,
    likeCount: options.likes ?? 0,
    replyCount: 0,
    createdAt: 1_800_000_000,
    likedByAuthor: false,
    author: null,
    source: "signer",
  };
}

describe("comment mining", () => {
  it("tokenizes away stopwords and urls", () => {
    expect(tokenize("Please do Karen next! https://tiktok.com/x")).toEqual(["karen"]);
  });

  it("extracts proper-noun name suggestions", () => {
    expect(extractNames("do Karen next, then Deborah please")).toEqual(["Karen", "Deborah"]);
  });

  it("clusters repeated requests into one ranked idea", () => {
    const ideas = mineIdeas(
      [
        comment("do Karen next!!", { likes: 120 }),
        comment("please do Karen next, my mom is a Karen", { likes: 80 }),
        comment("Karen is such a good name", { likes: 10 }),
        comment("what about Deborah?", { likes: 30 }),
        comment("do Deborah next please", { likes: 25 }),
      ],
      { now: 1_800_000_000 },
    );

    expect(ideas).toHaveLength(2);
    expect(ideas[0]!.concept).toBe("karen");
    expect(ideas[0]!.mentions).toBe(3);
    expect(ideas[0]!.totalLikes).toBe(210);
    expect(ideas[0]!.demandScore).toBeGreaterThan(ideas[1]!.demandScore);
    expect(ideas[0]!.sampleComments[0]).toBe("do Karen next!!");
  });

  it("drops one-off comments below the mention threshold", () => {
    const ideas = mineIdeas([comment("do Brittany next")], { now: 1_800_000_000 });
    expect(ideas).toEqual([]);
  });

  it("weights comments on our own videos above cohort noise", () => {
    const comments = [
      comment("do Karen next", { likes: 10, videoId: "ours" }),
      comment("do Karen next", { likes: 10, videoId: "ours" }),
    ];
    const ownWeighted = mineIdeas(comments, { now: 1_800_000_000, ownVideoIds: ["ours"] });
    const cohortWeighted = mineIdeas(comments, { now: 1_800_000_000, ownVideoIds: [] });
    expect(ownWeighted[0]!.demandScore).toBeGreaterThan(cohortWeighted[0]!.demandScore);
  });

  it("carries evidence rows for the backlog", () => {
    const ideas = mineIdeas(
      [comment("80s names that vanished please"), comment("80s names that vanished, do it")],
      { now: 1_800_000_000 },
    );
    expect(ideas[0]!.evidence).toHaveLength(2);
    expect(ideas[0]!.evidence[0]!.commentId).toMatch(/^c\d+$/);
  });
});

describe("comment sentiment", () => {
  it("scores positive and negative comments apart", () => {
    const bucket = analyzeSentiment([
      comment("love this so much, amazing"),
      comment("this is the best series"),
      comment("terrible take, boring"),
      comment("what time is it"),
    ]);
    expect(bucket.positive).toBe(2);
    expect(bucket.negative).toBe(1);
    expect(bucket.neutral).toBe(1);
    expect(bucket.score).toBeGreaterThan(0);
  });

  it("handles negation", () => {
    const bucket = analyzeSentiment([comment("not good at all")]);
    expect(bucket.negative).toBe(1);
    expect(bucket.positive).toBe(0);
  });

  it("reports the top topics", () => {
    const bucket = analyzeSentiment([
      comment("do Karen next"),
      comment("Karen is great"),
      comment("Deborah when"),
    ]);
    expect(bucket.topTopics[0]!.topic).toBe("karen");
    expect(bucket.topTopics[0]!.count).toBe(2);
  });
});
