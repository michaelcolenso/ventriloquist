import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderCommandLine, shellQuote } from "../src/render";

function echoed(story: string): string {
  const line = renderCommandLine("printf '%s' {story}", { story, out: "/tmp/out.mp4" });
  return execFileSync("/bin/sh", ["-c", line], { encoding: "utf8" });
}

describe("render command template", () => {
  it("passes a hostile story through as one literal argument", () => {
    for (const story of ["kunta; touch /tmp/pwned", "$(id)", "`id`", "it's", "a b\nc", ""]) {
      expect(echoed(story)).toBe(story);
    }
  });

  it("quotes every placeholder occurrence", () => {
    expect(renderCommandLine("nbn render --story {story} --out {out} # {story}", { story: "x", out: "/o" })).toBe(
      "nbn render --story 'x' --out '/o' # 'x'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
