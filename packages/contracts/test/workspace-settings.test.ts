import { describe, expect, it } from "vitest";

import { UI_BRIDGE_COMMANDS } from "../src/ui-bridge.js";
import { DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS } from "../src/browser-history.js";
import { IPC_COMMANDS, parseCommandPayload } from "../src/ipc.js";
import { DEFAULT_TAINT_MODE, gateObservationOf, taintDoctorLine } from "../src/tool-policy.js";
import {
  taintModeOf,
  injectionDetectorModeOf,
  DEFAULT_INJECTION_DETECTOR_MODE,
  taintModeRank,
  homeDmLinked,
  homeDmLinkPrivacyNote,
  parseHomeDmLink,
  WorkspaceSettingsPayloadSchema,
  WorkspaceSettingsRecordSchema,
  WorkspaceSettingsSchema,
  absentWorkspaceSettings,
  activitySummariesOn,
  canonicalTimeZone,
  effectiveNoThumbnailHosts,
  parseNoThumbnailHosts,
  parseOnOff,
  parseSettingModelTarget,
  isValidTimeZone,
  workspaceSettingsAnswerOf,
  keptModelRequests,
  promptLayoutOf,
  PromptLayoutSchema,
  DEFAULT_PROMPT_LAYOUT,
  parseKeptModelRequests,
} from "../src/workspace-settings.js";
import { DEFAULT_KEPT_MODEL_REQUESTS, MAX_KEPT_MODEL_REQUESTS } from "../src/model-accounting.js";

describe("isValidTimeZone", () => {
  it("accepts what the platform resolves and refuses the rest", () => {
    for (const zone of ["Europe/Berlin", "America/New_York", "UTC", "Asia/Kolkata"]) expect(isValidTimeZone(zone)).toBe(true);
    for (const zone of ["", "Mars/Olympus", "Europe/Berlin ", "x".repeat(65)]) expect(isValidTimeZone(zone)).toBe(false);
  });

  it("stores one spelling per zone", () => {
    expect(canonicalTimeZone("europe/berlin")).toBe("Europe/Berlin");
    expect(canonicalTimeZone("Mars/Olympus")).toBeUndefined();
  });
});

describe("WorkspaceSettingsSchema", () => {
  it("is a strict document of optional keys", () => {
    expect(WorkspaceSettingsSchema.parse({})).toEqual({});
    expect(WorkspaceSettingsSchema.parse({ timezone: "Europe/Berlin" })).toEqual({ timezone: "Europe/Berlin" });
    expect(WorkspaceSettingsSchema.safeParse({ timezone: "Mars/Olympus" }).success).toBe(false);
    // A key this build does not know is refused, never kept unread.
    expect(WorkspaceSettingsSchema.safeParse({ theme: "dark" }).success).toBe(false);
  });

  it("describes a workspace that never saved as revision zero with nothing set", () => {
    const absent = absentWorkspaceSettings("default");
    expect(WorkspaceSettingsRecordSchema.parse(absent)).toEqual({
      workspaceId: "default",
      settings: {},
      revision: 0,
      updatedAt: null,
      actor: null,
    });
  });
});

describe("the workspace-settings command", () => {
  it("is an IPC command a page may send", () => {
    expect(IPC_COMMANDS).toContain("workspace-settings");
    expect(UI_BRIDGE_COMMANDS).toContain("workspace-settings");
    expect(parseCommandPayload("workspace-settings", { action: "get" }).ok).toBe(true);
  });

  it("takes a key for a write, a value only for set, and nothing else for get", () => {
    const ok = (payload: unknown) => WorkspaceSettingsPayloadSchema.safeParse(payload).success;
    expect(ok({ action: "get", workspaceId: "default" })).toBe(true);
    expect(ok({ action: "set", key: "timezone", value: "Europe/Berlin" })).toBe(true);
    expect(ok({ action: "set", key: "timezone", value: "Europe/Berlin", expectedRevision: 3 })).toBe(true);
    expect(ok({ action: "unset", key: "timezone" })).toBe(true);
    expect(ok({ action: "set", key: "timezone" })).toBe(false);
    expect(ok({ action: "set", value: "Europe/Berlin" })).toBe(false);
    expect(ok({ action: "unset", key: "timezone", value: "UTC" })).toBe(false);
    expect(ok({ action: "get", key: "timezone" })).toBe(false);
    expect(ok({ action: "set", key: "theme", value: "dark" })).toBe(false);
    // A disclosure accepted travels with the write; only `true` is a yes.
    expect(ok({ action: "set", key: "memory", value: '{"retrieval":"hybrid"}', confirmed: true })).toBe(true);
    expect(ok({ action: "set", key: "memory", value: '{"retrieval":"hybrid"}', confirmed: false })).toBe(false);
  });

  it("answers the stored document and what is in effect, the host zone filling a gap", () => {
    const record = { ...absentWorkspaceSettings("default"), revision: 2 };
    expect(workspaceSettingsAnswerOf(record, "Europe/London")).toEqual({
      workspaceId: "default",
      revision: 2,
      settings: {},
      effective: {
        timezone: "Europe/London",
        toolDeferral: "auto",
        activitySummaries: true,
        browserNoThumbnailHosts: [...DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS],
        homeChat: true,
        homeDmLink: false,
        keptModelRequests: 10,
        locale: "en",
        maxOutputTokens: 16384,
        promptLayout: "v2",
        travelFlightSearch: true,
        travelGoogleFlights: true,
        pdfEnabled: true,
        videoEnabled: true,
        videoKeepDays: 30,
        browserSessionIdleMinutes: 30,
        browserDownloadMaxMiB: 256,
        browserVisionEngine: "generic",
        redactToolResults: true,
        parallelReads: 8,
        memory: {
          enabled: true,
          capture: "suggest",
          autoApprove: [],
          digest: "weekly",
          sensitive: "skip",
          retrieval: "lexical",
          consolidation: "off",
          limits: { contextTokens: 8_000, evidence: 10, proposalDays: 30, maxRecords: 5_000 },
          provider: "tavi.memoryprovider",
          providerEgress: { records: false, conversation: false, includePersonal: false },
        },
        securityTaint: "enforce",
        skillSuggestions: true,
        tasksHome: "tavi",
        securityInjectionDetector: DEFAULT_INJECTION_DETECTOR_MODE,
      },
      hostTimezone: "Europe/London",
    });
    expect(workspaceSettingsAnswerOf({ ...record, settings: { timezone: "Asia/Tokyo" } }, "Europe/London").effective.timezone).toBe(
      "Asia/Tokyo",
    );
    // The built-in plugins turned off are named, sorted, only when the caller says which.
    expect(workspaceSettingsAnswerOf(record, "Europe/London", undefined, new Set(["tavi.video", "tavi.browser"])).disabledPlugins).toEqual([
      "tavi.browser",
      "tavi.video",
    ]);
    // Home is on unless set off.
    expect(workspaceSettingsAnswerOf({ ...record, settings: { homeChat: false } }, "Europe/London").effective.homeChat).toBe(false);
    // The DM link is in effect only while Home is on.
    expect(
      workspaceSettingsAnswerOf(
        { ...record, settings: { homeChat: false, homeDmLink: [{ connectionId: "telegram-default", senderId: "42" }] } },
        "Europe/London",
      ).effective.homeDmLink,
    ).toBe(false);
    expect(
      workspaceSettingsAnswerOf(
        { ...record, settings: { homeChat: true, homeDmLink: [{ connectionId: "telegram-default", senderId: "42" }] } },
        "Europe/London",
      ).effective.homeDmLink,
    ).toBe(true);
  });
});

describe("the kept model requests setting", () => {
  it("defaults to DEFAULT_KEPT_MODEL_REQUESTS and parses whole counts in range only", () => {
    expect(keptModelRequests({})).toBe(DEFAULT_KEPT_MODEL_REQUESTS);
    expect(keptModelRequests({ keptModelRequests: 0 })).toBe(0);
    expect(
      workspaceSettingsAnswerOf({ ...absentWorkspaceSettings("default"), settings: { keptModelRequests: 3 } }, "UTC").effective
        .keptModelRequests,
    ).toBe(3);
    expect(["0", " 25 ", "1000"].map(parseKeptModelRequests)).toEqual([0, 25, 1000]);
    for (const bad of ["-1", "1001", "2.5", "ten", "", "1e3"]) expect(parseKeptModelRequests(bad), bad).toBeUndefined();
    expect(WorkspaceSettingsSchema.safeParse({ keptModelRequests: MAX_KEPT_MODEL_REQUESTS + 1 }).success).toBe(false);
    expect(WorkspaceSettingsSchema.safeParse({ keptModelRequests: 1.5 }).success).toBe(false);
  });
});

describe("the prompt layout setting", () => {
  it("defaults to v2 and takes only v1 or v2", () => {
    expect(DEFAULT_PROMPT_LAYOUT).toBe("v2");
    expect(promptLayoutOf({})).toBe("v2");
    expect(promptLayoutOf({ promptLayout: "v1" })).toBe("v1");
    expect(
      workspaceSettingsAnswerOf({ ...absentWorkspaceSettings("default"), settings: { promptLayout: "v1" } }, "UTC").effective.promptLayout,
    ).toBe("v1");
    expect(WorkspaceSettingsSchema.safeParse({ promptLayout: "v3" }).success).toBe(false);
    expect(PromptLayoutSchema.options).toEqual(["v1", "v2"]);
  });
});

describe("the task summary settings", () => {
  it("are on unless turned off", () => {
    expect(activitySummariesOn({})).toBe(true);
    expect(activitySummariesOn({ activitySummaries: true })).toBe(true);
    expect(activitySummariesOn({ activitySummaries: false })).toBe(false);
    const record = { ...absentWorkspaceSettings("default"), settings: { activitySummaries: false } };
    expect(workspaceSettingsAnswerOf(record, "UTC").effective.activitySummaries).toBe(false);
  });

  it("store a boolean and a connection/model target", () => {
    expect(
      WorkspaceSettingsSchema.parse({ activitySummaries: false, activitySummaryModel: { connectionId: "ollama", model: "llama3" } }),
    ).toEqual({
      activitySummaries: false,
      activitySummaryModel: { connectionId: "ollama", model: "llama3" },
    });
    expect(WorkspaceSettingsSchema.safeParse({ activitySummaries: "off" }).success).toBe(false);
    expect(WorkspaceSettingsSchema.safeParse({ activitySummaryModel: { connectionId: "Not A Slug", model: "m" } }).success).toBe(false);
  });

  it("read on/off and <connection>/<model> as typed", () => {
    expect(parseOnOff("off")).toBe(false);
    expect(parseOnOff(" ON ")).toBe(true);
    expect(parseOnOff("false")).toBe(false);
    expect(parseOnOff("maybe")).toBeUndefined();
    // The connection is a slug, so the model keeps every later slash.
    expect(parseSettingModelTarget("openrouter/openai/gpt-4.1-mini")).toEqual({ connectionId: "openrouter", model: "openai/gpt-4.1-mini" });
    expect(parseSettingModelTarget("ollama")).toBeUndefined();
    expect(parseSettingModelTarget("/model")).toBeUndefined();
    expect(parseSettingModelTarget("ollama/")).toBeUndefined();
  });

  it("are keys the command addresses, with room for a long model name", () => {
    const ok = (payload: unknown) => WorkspaceSettingsPayloadSchema.safeParse(payload).success;
    expect(ok({ action: "set", key: "activitySummaries", value: "off" })).toBe(true);
    expect(ok({ action: "set", key: "activitySummaryModel", value: `openrouter/${"m".repeat(200)}` })).toBe(true);
    expect(ok({ action: "unset", key: "activitySummaryModel" })).toBe(true);
  });
});

describe("the DM link to Home", () => {
  it("parses <connection>:<sender> identities, and off as none; which are chat DMs is checked where the setting is applied", () => {
    expect(parseHomeDmLink("telegram-default:42, telegram-default:42,telegram-work:7")).toEqual({
      identities: [
        { connectionId: "telegram-default", senderId: "42" },
        { connectionId: "telegram-work", senderId: "7" },
      ],
    });
    expect(parseHomeDmLink("off")).toEqual({ identities: [] });
    expect(parseHomeDmLink("mailgun-default:me@example.com")).toEqual({
      identities: [{ connectionId: "mailgun-default", senderId: "me@example.com" }],
    });
    expect(parseHomeDmLink("on")).toEqual({ invalid: "on" });
    expect(parseHomeDmLink(":42")).toEqual({ invalid: ":42" });
  });

  it("links a listed identity only while Home is on, and names the identities in the note", () => {
    const listed = [{ connectionId: "telegram-default", senderId: "42" }];
    expect(homeDmLinked({ homeChat: true, homeDmLink: listed }, "telegram-default", "42")).toBe(true);
    expect(homeDmLinked({ homeChat: true, homeDmLink: listed }, "telegram-default", "43")).toBe(false);
    expect(homeDmLinked({ homeDmLink: listed }, "telegram-default", "42")).toBe(true);
    expect(homeDmLinked({ homeChat: false, homeDmLink: listed }, "telegram-default", "42")).toBe(false);
    expect(homeDmLinkPrivacyNote(listed)).toContain("from telegram-default:42 now become turns of your Home");
  });
});

describe("the browser no-thumbnail hosts", () => {
  it("default to the shipped list until a workspace sets its own, which may be empty", () => {
    expect(effectiveNoThumbnailHosts({})).toEqual(DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS);
    expect(effectiveNoThumbnailHosts({ browserNoThumbnailHosts: [] })).toEqual([]);
    const record = { ...absentWorkspaceSettings("default"), settings: { browserNoThumbnailHosts: ["a.com"] } };
    expect(workspaceSettingsAnswerOf(record, "UTC").effective.browserNoThumbnailHosts).toEqual(["a.com"]);
  });

  it("parse a comma-separated list into the stored form, and name the first bad entry", () => {
    expect(parseNoThumbnailHosts(" Mail.Example.com , *.BANK,mail.example.com ")).toEqual({ hosts: ["mail.example.com", "*.bank"] });
    expect(parseNoThumbnailHosts("none")).toEqual({ hosts: [] });
    expect(parseNoThumbnailHosts("bücher.de")).toEqual({ hosts: ["xn--bcher-kva.de"] });
    expect(parseNoThumbnailHosts("a.com,https://b.com/x")).toEqual({ invalid: "https://b.com/x" });
    expect(parseNoThumbnailHosts("a.com:8080")).toEqual({ invalid: "a.com:8080" });
    expect(parseNoThumbnailHosts(" , ")).toEqual({ invalid: " , " });
  });

  it("store only normalized entries, and take a long list through the command", () => {
    expect(WorkspaceSettingsSchema.safeParse({ browserNoThumbnailHosts: ["a.com", "*.bank"] }).success).toBe(true);
    expect(WorkspaceSettingsSchema.safeParse({ browserNoThumbnailHosts: ["A.com"] }).success).toBe(false);
    expect(WorkspaceSettingsSchema.safeParse({ browserNoThumbnailHosts: ["a.com/path"] }).success).toBe(false);
    const long = Array.from({ length: 150 }, (_, index) => `host-${index}.example.com`).join(",");
    expect(WorkspaceSettingsPayloadSchema.safeParse({ action: "set", key: "browserNoThumbnailHosts", value: long }).success).toBe(true);
  });
});

describe("security.injectionDetector", () => {
  it("defaults to the measured default; the workspace's mode applies", () => {
    expect(injectionDetectorModeOf({})).toBe(DEFAULT_INJECTION_DETECTOR_MODE);
    expect(injectionDetectorModeOf({ securityInjectionDetector: "model" })).toBe("model");
    expect(WorkspaceSettingsSchema.safeParse({ securityInjectionDetector: "strict" }).success).toBe(false);
    expect(WorkspaceSettingsPayloadSchema.safeParse({ action: "set", key: "securityInjectionDetector", value: "patterns" }).success).toBe(
      true,
    );
    expect(
      workspaceSettingsAnswerOf({ ...absentWorkspaceSettings("default"), settings: { securityInjectionDetector: "patterns" } }, "UTC")
        .effective.securityInjectionDetector,
    ).toBe("patterns");
  });
});

describe("security.taint", () => {
  it("defaults to enforce; the workspace's mode applies, and an owner's --taint-policy over it", () => {
    expect(DEFAULT_TAINT_MODE).toBe("enforce");
    expect(taintModeOf({})).toBe("enforce");
    expect(taintModeOf({ securityTaint: "observe" })).toBe("observe");
    expect(taintModeOf({ securityTaint: "enforce" })).toBe("enforce");
    expect(taintModeOf({ securityTaint: "enforce" }, "off")).toBe("off");
    expect(taintModeOf({ securityTaint: "off" }, "enforce")).toBe("enforce");
    expect(["off", "observe", "enforce"].map((mode) => taintModeRank(mode as "off"))).toEqual([0, 1, 2]);
    expect(WorkspaceSettingsSchema.safeParse({ securityTaint: "strict" }).success).toBe(false);
    expect(WorkspaceSettingsPayloadSchema.safeParse({ action: "set", key: "securityTaint", value: "enforce" }).success).toBe(true);
  });

  it("answers the mode in force and names an owner's override", () => {
    const record = { ...absentWorkspaceSettings("default"), settings: { securityTaint: "enforce" as const } };
    expect(workspaceSettingsAnswerOf(record, "UTC").effective.securityTaint).toBe("enforce");
    expect(workspaceSettingsAnswerOf(record, "UTC").taintPolicy).toBeUndefined();
    const overridden = workspaceSettingsAnswerOf(record, "UTC", "observe");
    expect(overridden.effective.securityTaint).toBe("observe");
    expect(overridden.taintPolicy).toBe("observe");
    expect(overridden.settings.securityTaint).toBe("enforce");
  });

  it("observes a verdict's taint ask, enforced or only observed, and says it for doctor", () => {
    const call = { taskId: "task-1", callId: "c1", effect: "external" as const, sink: "network" as const, at: "2026-10-10T00:00:00.000Z" };
    const base = {
      toolId: "http.request",
      risk: { level: "high" as const, reasons: [], tainted: true },
      allowedScopes: ["once" as const],
      display: { title: "Post" },
    };
    expect(gateObservationOf({ ...base, decision: "allow" }, call)).toBeUndefined();
    expect(gateObservationOf({ ...base, decision: "allow", observedGateReason: "tainted-payload" }, call)).toEqual({
      taskId: "task-1",
      callId: "c1",
      toolId: "http.request",
      effect: "external",
      sink: "network",
      decisionEnforced: "allow",
      decisionObserved: "ask",
      gateReason: "tainted-payload",
      createdAt: call.at,
    });
    expect(gateObservationOf({ ...base, decision: "deny", gateReason: "novel-url" }, call)).toMatchObject({
      decisionEnforced: "deny",
      decisionObserved: "ask",
      gateReason: "novel-url",
    });
    const summary = {
      calls: 3,
      tasks: 2,
      unasked: 2,
      topTools: [
        { toolId: "http.request", calls: 2 },
        { toolId: "messaging.send_to", calls: 1 },
      ],
    };
    expect(taintDoctorLine("observe", summary)).toBe(
      "taint would have asked 3 calls in 7 days (top tools http.request 2, messaging.send_to 1)",
    );
    expect(taintDoctorLine("enforce", { ...summary, calls: 1, topTools: [{ toolId: "http.request", calls: 1 }] })).toBe(
      "taint asked 1 call in 7 days (top tools http.request 1)",
    );
    expect(taintDoctorLine("observe", { calls: 0, tasks: 0, unasked: 0, topTools: [] })).toBe("taint would have asked 0 calls in 7 days");
  });
});
