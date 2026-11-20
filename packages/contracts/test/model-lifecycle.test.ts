import { describe, expect, it } from "vitest";

import {
  daysBetween,
  lifecycleWarnings,
  lifecycleWarningText,
  ModelLifecycleSchema,
  worstLifecycleLevel,
  type LifecycleWarning,
  type ModelLifecycle,
} from "../src/model-lifecycle.js";

const TODAY = "2026-11-20";
const base = { catalogVersion: "2026-11-20.1", checkedAt: "2026-11-20T08:00:00.000Z" } as const;
const lifecycle = (facts: Partial<ModelLifecycle>): ModelLifecycle => ModelLifecycleSchema.parse({ status: "ga", ...base, ...facts });

describe("model lifecycle warnings", () => {
  it("warns of a confirmed end within 30 days: claude-sonnet-4-5 on Anthropic", () => {
    const sonnet = lifecycle({ status: "deprecated", deprecatedOn: "2026-09-30", retiresOn: "2026-11-30", endClaimedOn: "2026-11-30" });
    expect(lifecycleWarnings(sonnet, TODAY)).toEqual([{ level: "warning", code: "retires_soon", date: "2026-11-30", days: 10 }]);
  });

  it("warns of a redirect with no end date: gemini-2.5-pro on Gemini", () => {
    const pro = lifecycle({
      status: "deprecated",
      endClaimedOn: "2026-12-01",
      redirect: { on: "2026-12-01", to: "gemini-3.8-flash" },
      closedToNewOn: "2026-09-18",
    });
    expect(lifecycleWarnings(pro, TODAY)).toEqual([
      { level: "warning", code: "redirects_soon", to: "gemini-3.8-flash", date: "2026-12-01", days: 11 },
      { level: "info", code: "end_claimed", date: "2026-12-01", days: 11 },
    ]);
  });

  it("warns of a router's redirect even while the router calls the model ga: google/gemini-2.5-pro on OpenRouter", () => {
    const routed = lifecycle({ redirect: { on: "2026-12-01", to: "gemini-3.8-flash", via: "gemini" } });
    const warnings = lifecycleWarnings(routed, TODAY);
    expect(warnings).toMatchObject([{ level: "warning", code: "redirects_soon", via: "gemini" }]);
    expect(warnings.map(lifecycleWarningText)).toEqual(["will be answered and billed as gemini-3.8-flash (via gemini) on 2026-12-01"]);
  });

  it("calls a redirect already in force a warning", () => {
    expect(lifecycleWarnings(lifecycle({ status: "deprecated", redirect: { to: "gemini-3.6-flash" } }), TODAY)).toEqual([
      { level: "warning", code: "redirected", to: "gemini-3.6-flash" },
      { level: "info", code: "deprecated" },
    ]);
  });

  it("calls a model past its end retired, and says nothing else about it", () => {
    const gone = lifecycle({ status: "deprecated", retiresOn: "2026-11-01", redirect: { to: "x" } });
    expect(lifecycleWarnings(gone, TODAY)).toEqual([{ level: "error", code: "retired", date: "2026-11-01", days: -19 }]);
    expect(lifecycleWarnings(lifecycle({ status: "retired" }), TODAY)).toEqual([{ level: "error", code: "retired" }]);
  });

  it("gives an end between 30 and 90 days a notice, and a farther one only its deprecation", () => {
    expect(lifecycleWarnings(lifecycle({ status: "deprecated", retiresOn: "2027-01-14" }), TODAY)).toEqual([
      { level: "info", code: "retires_soon", date: "2027-01-14", days: 55 },
    ]);
    expect(lifecycleWarnings(lifecycle({ status: "deprecated", retiresOn: "2027-04-01", deprecatedOn: "2026-10-01" }), TODAY)).toEqual([
      { level: "info", code: "deprecated", date: "2026-10-01", days: -50 },
    ]);
    expect(lifecycleWarnings(lifecycle({ retiresOn: "2027-04-01" }), TODAY)).toEqual([]);
  });

  it("draws the warning line at 30 days and the notice line at 90", () => {
    const retiring = (retiresOn: string) => lifecycleWarnings(lifecycle({ retiresOn }), TODAY)[0]?.level;
    expect(retiring("2026-12-20")).toBe("warning");
    expect(retiring("2026-12-21")).toBe("info");
    expect(retiring("2027-02-18")).toBe("info");
    expect(retiring("2027-02-19")).toBeUndefined();
    expect(retiring(TODAY)).toBe("error");
  });

  it("calls a redirect whose day has passed redirected, and keeps no notice of a past claimed end", () => {
    expect(lifecycleWarnings(lifecycle({ redirect: { on: "2026-11-01", to: "next" } }), TODAY)).toEqual([
      { level: "warning", code: "redirected", to: "next", date: "2026-11-01", days: -19 },
    ]);
    expect(lifecycleWarnings(lifecycle({ endClaimedOn: "2026-11-01" }), TODAY)).toEqual([]);
  });

  it("refuses a day that does not exist", () => {
    expect(ModelLifecycleSchema.safeParse({ status: "ga", ...base, retiresOn: "2026-02-30" }).success).toBe(false);
  });

  it("words every warning", () => {
    const warnings: LifecycleWarning[] = [
      { level: "error", code: "retired", date: "2026-11-01" },
      { level: "error", code: "retired" },
      { level: "warning", code: "redirected", to: "next", date: "2026-11-01" },
      { level: "warning", code: "retires_soon", date: "2026-11-30" },
      { level: "info", code: "end_claimed", date: "2026-12-01" },
      { level: "info", code: "deprecated", date: "2026-09-30" },
      { level: "info", code: "deprecated" },
      { level: "info", code: "price_changes", date: "2026-12-15" },
    ];
    expect(warnings.map(lifecycleWarningText)).toEqual([
      "retired on 2026-11-01",
      "retired",
      "answered and billed as next since 2026-11-01",
      "retires on 2026-11-30",
      "may retire on 2026-12-01 (not confirmed by the provider)",
      "deprecated on 2026-09-30",
      "deprecated",
      "price changes on 2026-12-15",
    ]);
  });

  it("says nothing of a current model, and keeps no floor as an end", () => {
    expect(lifecycleWarnings(lifecycle({}), TODAY)).toEqual([]);
    expect(ModelLifecycleSchema.safeParse({ status: "ga", ...base, retiresNotBefore: "2027-09-22" }).success).toBe(false);
  });

  it("notices a price change within 90 days", () => {
    const priced = lifecycle({ nextPrice: { effectiveFrom: "2026-12-15", per1m: { input: "1", output: "5" } } });
    expect(lifecycleWarnings(priced, TODAY)).toEqual([{ level: "info", code: "price_changes", date: "2026-12-15", days: 25 }]);
    expect(lifecycleWarnings(lifecycle({ nextPrice: { effectiveFrom: "2026-11-01", per1m: {} } }), TODAY)).toEqual([]);
  });

  it("names the worst level and counts days across months", () => {
    expect(worstLifecycleLevel([])).toBeUndefined();
    expect(
      worstLifecycleLevel([
        { level: "info", code: "deprecated" },
        { level: "warning", code: "redirected", to: "x" },
      ]),
    ).toBe("warning");
    expect(daysBetween("2026-11-20", "2026-12-11")).toBe(21);
  });
});
