import { describe, expect, it } from "vitest";
import { TOOLS, TOOLS_BY_NAME } from "../src/mcp/tools";
import { describeTool, toolAnnotations } from "../src/mcp/registry";

/** Section 4 tools in the order they land. Phase 1 wires the 4.1/4.2 reads. */
const SPEC_TOOLS = [
  "tt_trending_hashtags",
  "tt_trending_sounds",
  "tt_search_videos",
  "tt_profile",
  "tt_video_detail",
  "tt_shadow_cohort",
  "tt_compare_accounts",
];

describe("MCP tool surface (spec section 4)", () => {
  it("implements every tool in the spec, plus the ops tool", () => {
    for (const name of SPEC_TOOLS) {
      expect(TOOLS_BY_NAME.has(name), `${name} is missing`).toBe(true);
    }
    expect(TOOLS).toHaveLength(SPEC_TOOLS.length + 1);
    expect(TOOLS_BY_NAME.has("tt_system_status")).toBe(true);
  });

  it("namespaces every tool with tt_ and uses unique names", () => {
    const names = TOOLS.map((tool) => tool.name);
    for (const name of names) expect(name.startsWith("tt_")).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("labels risk tiers by capability class", () => {
    const byRisk = (risk: string) => TOOLS.filter((tool) => tool.risk === risk).map((tool) => tool.name);
    expect(byRisk("GREEN")).toHaveLength(TOOLS.length);
  });

  it("embeds the risk tier and its caveat in every tool description", () => {
    for (const tool of TOOLS) {
      const description = describeTool(tool);
      expect(description.startsWith("[")).toBe(true);
      expect(description).toContain(tool.title);
      expect(description).toContain("Risk:");

      if (tool.risk === "RED") {
        expect(description).toContain("5 posts/day");
        expect(description).toContain("halt-on-failure");
        expect(toolAnnotations(tool).destructiveHint).toBe(true);
        expect(toolAnnotations(tool).readOnlyHint).toBe(false);
      } else if (tool.risk === "AMBER") {
        expect(description).toContain("burner session");
        expect(toolAnnotations(tool).readOnlyHint).toBe(true);
      } else {
        expect(description).toContain("No session");
        expect(toolAnnotations(tool).readOnlyHint).toBe(true);
      }
    }
  });

  it("gives every tool a non-trivial description and an input schema", () => {
    for (const tool of TOOLS) {
      expect(tool.summary.length).toBeGreaterThan(40);
      expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
      expect(tool.title.length).toBeGreaterThan(2);
    }
  });
});
