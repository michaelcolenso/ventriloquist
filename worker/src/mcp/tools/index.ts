import type { ToolDefinition } from "../registry";
import {
  emergingInNicheTool,
  hashtagMomentumTool,
  searchVideosTool,
  soundLifecycleTool,
  trendingHashtags,
  trendingSounds,
} from "./trends";
import { compareAccountsTool, profileTool, shadowCohortTool, videoDetailTool } from "./accounts";
import { systemStatusTool } from "./system";

// `ToolDefinition<any>` erases the per-tool zod shape so the collection can hold
// heterogeneous schemas; each tool still type-checks its own handler input.
export const TOOLS: ToolDefinition<any>[] = [
  // 4.1 Trend intelligence
  trendingHashtags,
  trendingSounds,
  hashtagMomentumTool,
  emergingInNicheTool,
  searchVideosTool,
  soundLifecycleTool,
  // 4.2 Account & video intelligence
  profileTool,
  videoDetailTool,
  shadowCohortTool,
  compareAccountsTool,
  // Ops
  systemStatusTool,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
