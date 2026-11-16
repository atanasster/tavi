import { describe, expect, it } from "vitest";
import {
  ROUTINE_LLM_RELEASES_INSTRUCTIONS,
  ROUTINE_NEWS_INSTRUCTIONS,
  RoutineReportSpecSchema,
  isBuiltinRoutineTemplate,
  routineDefaultInstructions,
  routineDefaults,
  routineFileSlug,
  routineReportFileName,
  routineReportTitle,
  routineTemplateIdOf,
} from "../src/index.js";

const report = routineDefaults("Europe/Sofia").report;
const snapshot = (templateVersion: string, instructions: string) => ({
  report: RoutineReportSpecSchema.parse({ ...report, templateVersion }),
  agent: { agentId: "news", revision: 1, name: "Battery Watch", instructions, hash: "a".repeat(64) },
});

describe("the host's routine templates", () => {
  it("are news-v1 and llm-releases-v1, saved by id alone", () => {
    expect(isBuiltinRoutineTemplate("news-v1")).toBe(true);
    expect(isBuiltinRoutineTemplate("llm-releases-v1")).toBe(true);
    expect(isBuiltinRoutineTemplate("trends-v1")).toBe(false);
    expect(RoutineReportSpecSchema.safeParse({ ...report, templateVersion: "llm-releases-v1" }).success).toBe(true);
    expect(routineDefaultInstructions("news-v1")).toBe(ROUTINE_NEWS_INSTRUCTIONS);
    expect(routineDefaultInstructions("llm-releases-v1")).toBe(ROUTINE_LLM_RELEASES_INSTRUCTIONS);
    expect(ROUTINE_NEWS_INSTRUCTIONS).not.toMatch(/LLM|model/);
  });

  it("run a news-v1 revision saved with the LLM-release default as llm-releases-v1, and any other as itself", () => {
    const old = snapshot("news-v1", ROUTINE_LLM_RELEASES_INSTRUCTIONS);
    expect(routineTemplateIdOf(old)).toBe("llm-releases-v1");
    expect(routineReportTitle(old, "Battery Watch")).toBe("LLM news");
    expect(routineReportFileName(old, "Battery Watch")).toBe("llm-news");
    const news = snapshot("news-v1", "Find battery news");
    expect(routineTemplateIdOf(news)).toBe("news-v1");
    expect(routineReportTitle(news, "Battery Watch")).toBe("Battery Watch");
    expect(routineReportFileName(news, "Battery Watch")).toBe("battery-watch");
    expect(routineTemplateIdOf(snapshot("llm-releases-v1", "Find battery news"))).toBe("llm-releases-v1");
  });

  it("name a delivered file by a slug of the routine's name", () => {
    expect(routineFileSlug("Battery Watch: Solid-State")).toBe("battery-watch-solid-state");
    expect(routineFileSlug("Café Économie 2026")).toBe("cafe-economie-2026");
    expect(routineFileSlug("新闻")).toBe("routine-report");
    expect(routineFileSlug(`${"a".repeat(59)} b`)).toBe("a".repeat(59));
  });
});
