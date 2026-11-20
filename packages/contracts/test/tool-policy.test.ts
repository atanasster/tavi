import { describe, expect, it } from "vitest";

import {
  toolAnnotationsOf,
  SHIPPED_TOOL_RULES,
  escapeGlob,
  flagAllowRules,
  seededReminderRule,
  REMINDER_ALLOW_RULE_NOTE,
  TODO_ALLOW_RULE_NOTE,
  WEB_SEARCH_ALLOW_RULE_NOTE,
  PROPOSAL_ALLOW_RULE_NOTE,
  resumeIntentIdentity,
  UNPARSED_SUBJECT_PREFIX,
  effectiveEffect,
  evaluateGate,
  ruleAppliesTo,
  ruleAppliesToTurn,
  ToolRuleSchema,
  globMatches,
  readShellScript,
  SHELL_BRACED_EXPANSION_REASON,
  SHELL_CONTINUATION_REASON,
  SHELL_PROCESS_SUBSTITUTION_REASON,
  SHELL_QUOTING_REASON,
  splitShellCommands,
  toolPatternMatches,
  unattendedDenial,
  reachesSchedulingWrite,
  schedulingPatternRefusal,
  scheduledWorkDenial,
  RETIRED_SCHEDULING_READS,
  SCHEDULING_READ_ONLY_TOOLS,
  injectionWarningReason,
  isInjectionWarning,
  withInjectionWarning,
  trustedLabel,
  untrustedLabel,
  type CallAssessment,
  type GateEvaluationInput,
  type GateVerdict,
  type BrowserStep,
  type SessionGrant,
  type ToolRule,
  GateVerdictSchema,
  ScheduleToolPatternSchema,
  ToolPatternSchema,
  toolMediaListOf,
  toolMediaOf,
  APPROVAL_FORM_BUDGET,
  clipForm,
} from "../src/index.js";

const rule = (partial: Partial<ToolRule> & Pick<ToolRule, "ruleId" | "toolPattern" | "decision">): ToolRule => ({
  workspaceId: "default",
  source: "operator",
  createdBy: "operator",
  createdVia: "cli",
  createdAt: "2026-09-27T00:00:00.000Z",
  ...partial,
});

const assessment = (subjects: readonly string[], risk: CallAssessment["risk"] = "medium", hardDeny?: string): CallAssessment => ({
  display: { title: "Run it" },
  subjects,
  risk,
  reasons: [],
  ...(hardDeny === undefined ? {} : { hardDeny }),
});

const base: GateEvaluationInput = {
  toolId: "sandbox.run",
  effect: "external",
  rules: [],
  sessionGrants: [],
  gatedEffects: new Set(["mutating", "external"]),
  tainted: false,
};

describe("tool patterns and globs", () => {
  it("matches a dotted glob one segment at a time", () => {
    expect(toolPatternMatches("browser.*", "browser.act")).toBe(true);
    expect(toolPatternMatches("browser.*", "web_fetch")).toBe(false);
    expect(toolPatternMatches("*", "anything.at_all")).toBe(true);
    expect(toolPatternMatches("web_search", "web_search")).toBe(true);
    expect(toolPatternMatches("web_*", "web_search")).toBe(true);
    expect(toolPatternMatches("web_*", "web_fetch")).toBe(true);
    expect(toolPatternMatches("web.*", "web_search")).toBe(false);
    expect(toolPatternMatches("web_*", "web_other")).toBe(false);
  });

  it("refuses the retired dotted web patterns in rules and schedules, naming the web tools", () => {
    for (const schema of [ToolPatternSchema, ScheduleToolPatternSchema]) {
      for (const stale of ["web.search", "web.fetch", "web.*"]) {
        const parsed = schema.safeParse(stale);
        expect(parsed.success).toBe(false);
        const message = parsed.error?.issues.map((issue) => issue.message).join("; ") ?? "";
        for (const named of ["web_search", "web_fetch", "web_*"]) expect(message).toContain(named);
      }
      for (const current of ["web_search", "web_fetch", "web_*"]) expect(schema.safeParse(current).success).toBe(true);
    }
  });

  it("escapes a subject into a glob that matches it and nothing else", () => {
    const glob = escapeGlob("ls *.ts \\ ?");
    expect(globMatches(glob, "ls *.ts \\ ?")).toBe(true);
    expect(globMatches(glob, "ls a.ts \\ x")).toBe(false);
  });

  it("anchors a glob and treats regex characters literally", () => {
    expect(globMatches("ls *", "ls -la")).toBe(true);
    expect(globMatches("ls *", "rm -rf / ; ls x")).toBe(false);
    expect(globMatches("GET https://api.example.com/*", "GET https://api.example.com/v1")).toBe(true);
    expect(globMatches("a.b", "axb")).toBe(false);
  });

  it("keeps the glob semantics: ?, escapes, empty runs, trailing backslash, newlines", () => {
    expect(globMatches("a?c", "abc")).toBe(true);
    expect(globMatches("a?c", "ac")).toBe(false);
    expect(globMatches("a*", "a")).toBe(true);
    expect(globMatches("*", "")).toBe(true);
    expect(globMatches("", "")).toBe(true);
    expect(globMatches("", "x")).toBe(false);
    expect(globMatches("a\\*b", "a*b")).toBe(true);
    expect(globMatches("a\\*b", "axb")).toBe(false);
    expect(globMatches("a\\?", "a?")).toBe(true);
    expect(globMatches("a\\", "a\\")).toBe(true);
    expect(globMatches("a*b", "a\nx\nb")).toBe(true);
    expect(globMatches("*.ts", "src/a.ts")).toBe(true);
    expect(globMatches("*a*b", "xaxxaxb")).toBe(true);
    expect(globMatches("*a*b", "xaxxaxc")).toBe(false);
  });

  it("matches a many-star glob in linear time", () => {
    const started = Date.now();
    expect(globMatches("*a*a*a*a*a*a*a*a*b", "a".repeat(60))).toBe(false);
    expect(globMatches("*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(4_000))).toBe(false);
    expect(globMatches("*a*a*a*a*a*a*a*a*b", `${"a".repeat(4_000)}b`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("evaluateGate", () => {
  it("never lets a session grant or an allow rule cover a critical-floor tool (a plugin tool whose manifest sets minRisk critical)", () => {
    const call = {
      ...base,
      toolId: "acme.rss.fetch",
      effect: "external" as const,
      assessment: {
        display: { title: "Run acme.rss.fetch" },
        subjects: [],
        risk: "critical" as const,
        reasons: ["its manifest rates every call critical"],
      },
    };
    const grant = {
      grantId: "g1",
      taskId: "t1",
      workspaceId: "default",
      toolId: "acme.rss.fetch",
      approvalId: "a1",
      createdBy: "operator",
      createdAt: "2026-09-27T00:00:00.000Z",
    };
    const granted = evaluateGate({ ...call, sessionGrants: [grant] });
    expect(granted.decision).toBe("ask");
    expect(granted.allowedScopes).toEqual(["once"]);
    expect(evaluateGate({ ...call, rules: [rule({ ruleId: "allow", toolPattern: "acme.rss.fetch", decision: "allow" })] }).decision).toBe(
      "ask",
    );
    // A "high" floor would not hold: the grant covers it.
    expect(evaluateGate({ ...call, assessment: { ...call.assessment, risk: "high" as const }, sessionGrants: [grant] }).decision).toBe(
      "allow",
    );
  });

  it("falls back to the effect default when nothing matches", () => {
    expect(evaluateGate(base).decision).toBe("ask");
    expect(evaluateGate({ ...base, effect: "read-only" }).decision).toBe("allow");
  });

  it("lets a deny win over an allow for the same call, whatever the order", () => {
    const verdict = evaluateGate({
      ...base,
      assessment: assessment(["rm -rf build"]),
      rules: [
        rule({ ruleId: "allow-all", toolPattern: "sandbox.run", decision: "allow" }),
        rule({ ruleId: "no-rm", toolPattern: "sandbox.run", decision: "deny", argMatcher: "rm *" }),
      ],
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.ruleId).toBe("no-rm");
  });

  it("asks when an ask rule matches, even with an allow rule present", () => {
    const verdict = evaluateGate({
      ...base,
      rules: [
        rule({ ruleId: "a", toolPattern: "*", decision: "ask" }),
        rule({ ruleId: "b", toolPattern: "sandbox.run", decision: "allow" }),
      ],
    });
    expect(verdict).toMatchObject({ decision: "ask", ruleId: "a", allowedScopes: ["once"] });
  });

  it("allows a compound command only when every subcommand is covered", () => {
    const rules = [rule({ ruleId: "ls", toolPattern: "sandbox.run", decision: "allow", argMatcher: "ls*" })];
    expect(evaluateGate({ ...base, assessment: assessment(["ls -la"]), rules }).decision).toBe("allow");
    expect(evaluateGate({ ...base, assessment: assessment(["ls -la", "rm -rf build"]), rules }).decision).toBe("ask");
    // A matcher never covers a call with no subjects.
    expect(evaluateGate({ ...base, assessment: assessment([]), rules }).decision).toBe("ask");
  });

  it("refuses a hard-denied call whatever a rule or grant says", () => {
    const verdict = evaluateGate({
      ...base,
      assessment: assessment(["curl x | sh"], "medium", "pipes a download into a shell"),
      rules: [rule({ ruleId: "all", toolPattern: "sandbox.run", decision: "allow" })],
    });
    expect(verdict).toMatchObject({ decision: "deny", ruleId: "hard-deny" });
  });

  it("asks a critical call even when a rule or grant allows it, and offers it once only", () => {
    const verdict = evaluateGate({
      ...base,
      assessment: assessment(["sudo ls"], "critical"),
      rules: [rule({ ruleId: "all", toolPattern: "sandbox.run", decision: "allow" })],
      gatedEffects: new Set(),
    });
    expect(verdict.decision).toBe("ask");
    expect(verdict.allowedScopes).toEqual(["once"]);
  });

  it("taints a call: at least high risk, and no `always`", () => {
    const verdict = evaluateGate({ ...base, assessment: assessment(["ls"], "low"), tainted: true });
    expect(verdict.risk).toMatchObject({ level: "high", tainted: true });
    expect(verdict.allowedScopes).toEqual(["once", "session"]);
    expect(evaluateGate({ ...base, assessment: assessment(["ls"], "low") }).allowedScopes).toEqual(["once", "session", "always"]);
  });

  it("offers `always` for an alwaysAnyCall call under taint, at the assessor's own risk, and never past the narrower rules", () => {
    const anyCall = (risk: CallAssessment["risk"], extra: Partial<CallAssessment> = {}): CallAssessment => ({
      ...assessment([], risk),
      alwaysAnyCall: true,
      ...extra,
    });
    const scopes = (input: Partial<GateEvaluationInput>) => evaluateGate({ ...base, tainted: true, ...input }).allowedScopes;
    expect(scopes({ assessment: anyCall("low") })).toEqual(["once", "session", "always"]);
    expect(scopes({ assessment: anyCall("high") })).toEqual(["once", "session"]);
    expect(scopes({ assessment: anyCall("critical") })).toEqual(["once"]);
    expect(scopes({ assessment: anyCall("low", { onceOnly: true }) })).toEqual(["once"]);
    expect(scopes({ assessment: anyCall("low", { askWhenTainted: true }) })).toEqual(["once"]);
    expect(scopes({ assessment: anyCall("low"), rules: [rule({ ruleId: "a", toolPattern: "sandbox.run", decision: "ask" })] })).toEqual([
      "once",
    ]);
    // Subjects would make the rule the call's own, which injected content may have chosen: the usual scopes apply.
    expect(scopes({ assessment: { ...anyCall("low"), subjects: ["ls"] } })).toEqual(["once", "session"]);
  });

  it("keeps `always` for an alwaysAnyCall call that is also grouped, as web search is", () => {
    const verdict = evaluateGate({
      ...base,
      toolId: "web_search",
      tainted: true,
      assessment: { ...assessment([], "low"), alwaysAnyCall: true, scopeGroup: "web_search" },
    });
    expect(verdict).toMatchObject({ allowedScopes: ["once", "session", "always"], scopeGroup: "web_search" });
  });

  it("holds a call to the deny and ask rules of the tools it names as aliases, never their allow rules", () => {
    const batch = { ...assessment(["type", "scroll"]), scopeGroup: "browser.*", ruleAliases: ["browser.act"] };
    const verdict = (rules: GateEvaluationInput["rules"]) =>
      evaluateGate({ ...base, toolId: "browser.batch", effect: "external", assessment: batch, rules });
    expect(verdict([rule({ ruleId: "no-typing", toolPattern: "browser.act", decision: "deny", argMatcher: "type" })])).toMatchObject({
      decision: "deny",
      ruleId: "no-typing",
    });
    expect(verdict([rule({ ruleId: "ask-act", toolPattern: "browser.act", decision: "ask" })])).toMatchObject({
      decision: "ask",
      ruleId: "ask-act",
      allowedScopes: ["once"],
    });
    // An act allowed always does not allow a batch: it asks, as it would with no rule.
    expect(verdict([rule({ ruleId: "allow-act", toolPattern: "browser.act", decision: "allow" })]).decision).toBe("ask");
  });

  it("asks about acting by sight, and an Enter that submits, whatever allows the browser", () => {
    const rules = [...SHIPPED_TOOL_RULES, rule({ ruleId: "browser-always", toolPattern: "browser.*", decision: "allow" })];
    const grants = [
      {
        grantId: "g",
        taskId: "t1",
        workspaceId: "default",
        toolId: "browser.vision_act",
        approvalId: "a",
        createdBy: "operator",
        createdAt: "2026-10-08T00:00:00.000Z",
      },
    ];
    expect(
      evaluateGate({
        ...base,
        toolId: "browser.vision_act",
        effect: "external",
        assessment: assessment([], "high"),
        rules,
        sessionGrants: grants,
      }),
    ).toMatchObject({ decision: "ask", ruleId: "shipped-browser-vision" });
    expect(
      evaluateGate({ ...base, toolId: "browser.act", effect: "external", assessment: assessment(["submit"], "high"), rules }),
    ).toMatchObject({ decision: "ask", ruleId: "shipped-browser-submit" });
  });

  it("allows a call covered by a session grant for its task", () => {
    const verdict = evaluateGate({
      ...base,
      assessment: assessment(["npm test"]),
      sessionGrants: [
        {
          grantId: "g1",
          taskId: "t1",
          workspaceId: "default",
          toolId: "sandbox.run",
          argMatcher: "npm test",
          approvalId: "a1",
          createdBy: "operator",
          createdAt: "2026-09-27T00:00:00.000Z",
        },
      ],
    });
    expect(verdict).toMatchObject({ decision: "allow", ruleId: "g1" });
  });

  it("ships an allow for replies and questions that an operator ask rule overrides", () => {
    const reply = { ...base, toolId: "messaging.send", effect: "external" as const, rules: SHIPPED_TOOL_RULES };
    expect(evaluateGate(reply).decision).toBe("allow");
    expect(
      evaluateGate({ ...reply, rules: [...SHIPPED_TOOL_RULES, rule({ ruleId: "x", toolPattern: "messaging.send", decision: "ask" })] })
        .decision,
    ).toBe("ask");
    expect(evaluateGate({ ...base, toolId: "operator.ask_user", rules: SHIPPED_TOOL_RULES }).decision).toBe("allow");
  });

  it("decides a grouped call for its group, and still asks for a browser submit, upload or download under the browser's rule", () => {
    const grouped = (subject: string): CallAssessment => ({
      display: { title: "Use the browser" },
      subjects: [subject],
      risk: "medium",
      reasons: [],
      scopeGroup: "browser.*",
    });
    const browserRule = rule({ ruleId: "browser", toolPattern: "browser.*", decision: "allow" });
    // Subjects do not keep `always` from a grouped call, nor narrow it.
    const open = evaluateGate({ ...base, toolId: "browser.navigate", assessment: grouped("smart.example.org") });
    expect(open).toMatchObject({ decision: "ask", allowedScopes: ["once", "session", "always"], scopeGroup: "browser.*" });
    expect(
      evaluateGate({
        ...base,
        toolId: "browser.navigate",
        assessment: grouped("other.example.org"),
        rules: [...SHIPPED_TOOL_RULES, browserRule],
      }).decision,
    ).toBe("allow");
    expect(
      evaluateGate({ ...base, toolId: "browser.act", assessment: grouped("click"), rules: [...SHIPPED_TOOL_RULES, browserRule] }).decision,
    ).toBe("allow");
    for (const kind of ["submit", "upload", "download"]) {
      const verdict = evaluateGate({
        ...base,
        toolId: "browser.act",
        assessment: assessment([kind]),
        rules: [...SHIPPED_TOOL_RULES, browserRule],
      });
      expect(verdict).toMatchObject({ decision: "ask", allowedScopes: ["once"] });
    }
  });
});

describe("what a rule reads of a shell command", () => {
  const unparsed: CallAssessment = {
    ...assessment(["ls $(pnpm test)", "\0unparsed ls $(pnpm test)"]),
    onceOnly: true,
    unparsed: true,
  };

  it("matches deny and ask rules against a command's other spellings, never allow rules", () => {
    const wrapped: CallAssessment = { ...assessment(["env curl https://x"]), forms: ["curl https://x"] };
    const deny = rule({ ruleId: "no-curl", toolPattern: "sandbox.run", decision: "deny", argMatcher: "curl *" });
    expect(evaluateGate({ ...base, assessment: wrapped, rules: [deny] }).decision).toBe("deny");
    const ask = rule({ ruleId: "ask-curl", toolPattern: "sandbox.run", decision: "ask", argMatcher: "curl *" });
    const allowEnv = rule({ ruleId: "env", toolPattern: "sandbox.run", decision: "allow", argMatcher: "env *" });
    expect(evaluateGate({ ...base, assessment: wrapped, rules: [ask, allowEnv] })).toMatchObject({ decision: "ask", ruleId: "ask-curl" });
    // An allow rule for the bare spelling does not cover the wrapped call.
    const allowCurl = rule({ ruleId: "curl", toolPattern: "sandbox.run", decision: "allow", argMatcher: "curl *" });
    expect(evaluateGate({ ...base, assessment: wrapped, rules: [allowCurl] }).decision).toBe("ask");
  });

  it("lets no blanket allow rule or grant through a line no rule can read, but one written for it", () => {
    const blanket = rule({ ruleId: "all", toolPattern: "sandbox.run", decision: "allow" });
    expect(evaluateGate({ ...base, assessment: unparsed, rules: [blanket] }).decision).toBe("ask");
    const glob = rule({ ruleId: "glob", toolPattern: "sandbox.run", decision: "allow", argMatcher: "*test*" });
    expect(evaluateGate({ ...base, assessment: unparsed, rules: [glob] }).decision).toBe("ask");
    const grant = {
      grantId: "g",
      taskId: "t",
      workspaceId: "default",
      toolId: "sandbox.run",
      approvalId: "a",
      createdBy: "person",
      createdAt: "2026-10-31T00:00:00.000Z",
    };
    expect(evaluateGate({ ...base, assessment: unparsed, sessionGrants: [grant] }).decision).toBe("ask");
    const meant = { ...blanket, matchUnparsed: true as const };
    expect(evaluateGate({ ...base, assessment: unparsed, rules: [meant] }).decision).toBe("allow");
    // A plain line is still allowed by the blanket rule.
    expect(evaluateGate({ ...base, assessment: assessment(["ls"]), rules: [blanket] }).decision).toBe("allow");
  });
});

describe("the read-only rule", () => {
  const readOnly = rule({
    ruleId: "shipped-sandbox-readonly",
    toolPattern: "sandbox.run",
    decision: "allow",
    readOnly: true,
    source: "shipped",
  });

  it("allows what the assessor reads as read-only, and is never a blanket allow for anything else", () => {
    expect(evaluateGate({ ...base, assessment: { ...assessment(["ls"]), readOnly: true }, rules: [readOnly] }).decision).toBe("allow");
    expect(evaluateGate({ ...base, assessment: assessment(["rm -rf build"]), rules: [readOnly] }).decision).toBe("ask");
    // A deny or ask rule still holds a read-only call.
    const ask = rule({ ruleId: "ask-cat", toolPattern: "sandbox.run", decision: "ask", argMatcher: "cat *" });
    expect(evaluateGate({ ...base, assessment: { ...assessment(["cat x"]), readOnly: true }, rules: [ask, readOnly] }).decision).toBe(
      "ask",
    );
    expect(SHIPPED_TOOL_RULES.some((shipped) => shipped.readOnly === true && shipped.toolPattern === "sandbox.run")).toBe(true);
  });

  it("records the pattern a chat grant would store, only beside the subjects it stands for", () => {
    const offered = { ...assessment(["git diff src"]), sessionMatchers: ["git diff *"] };
    expect(evaluateGate({ ...base, assessment: offered }).sessionMatchers).toEqual(["git diff *"]);
    // Matchers that leave a subject uncovered are dropped: the grant would not cover the call shown.
    const mismatched = { ...assessment(["git diff src", "ls"]), sessionMatchers: ["git diff *"] };
    expect(evaluateGate({ ...base, assessment: mismatched }).sessionMatchers).toBeUndefined();
    const bare = { ...assessment(["cargo check"]), sessionMatchers: ["cargo check", "cargo check *"] };
    expect(evaluateGate({ ...base, assessment: bare }).sessionMatchers).toEqual(["cargo check", "cargo check *"]);
  });
});

describe("rules for a provider binding", () => {
  const bound = { ...base, toolId: "web_search", assessment: { ...assessment([]), bindingHash: "a".repeat(64) } };

  it("applies an allow rule with no binding hash to whichever binding the call resolves", () => {
    expect(evaluateGate({ ...bound, rules: [rule({ ruleId: "group", toolPattern: "web_*", decision: "allow" })] })).toMatchObject({
      decision: "allow",
      ruleId: "group",
    });
  });

  it("keeps an allow rule with a binding hash to that binding", () => {
    expect(
      evaluateGate({
        ...bound,
        rules: [rule({ ruleId: "same", toolPattern: "web_search", decision: "allow", bindingHash: "a".repeat(64) })],
      }),
    ).toMatchObject({ decision: "allow", ruleId: "same" });
    expect(
      evaluateGate({
        ...bound,
        rules: [rule({ ruleId: "other", toolPattern: "web_search", decision: "allow", bindingHash: "b".repeat(64) })],
      }).decision,
    ).toBe("ask");
  });

  it("still lets a deny or ask rule win over an unbound allow", () => {
    const allow = rule({ ruleId: "group", toolPattern: "web_*", decision: "allow" });
    expect(evaluateGate({ ...bound, rules: [allow, rule({ ruleId: "no", toolPattern: "web_search", decision: "deny" })] }).decision).toBe(
      "deny",
    );
    expect(evaluateGate({ ...bound, rules: [allow, rule({ ruleId: "check", toolPattern: "web_search", decision: "ask" })] }).decision).toBe(
      "ask",
    );
  });
});

describe("rules for one kind of task", () => {
  it("applies a rule with an origin only to tasks started that way", () => {
    const profile = rule({ ruleId: "p", toolPattern: "sandbox.run", decision: "deny", origin: "messaging" });
    expect(evaluateGate({ ...base, rules: [profile], origin: "messaging" }).decision).toBe("deny");
    expect(evaluateGate({ ...base, rules: [profile], origin: "cli" }).decision).toBe("ask");
    expect(evaluateGate({ ...base, rules: [profile] }).decision).toBe("ask");
  });

  it("applies a rule scoped to ipc to web tasks too, which were once ipc, but not the other way round", () => {
    const terminal = rule({ ruleId: "i", toolPattern: "sandbox.run", decision: "deny", origin: "ipc" });
    expect(evaluateGate({ ...base, rules: [terminal], origin: "ipc" }).decision).toBe("deny");
    expect(evaluateGate({ ...base, rules: [terminal], origin: "web" }).decision).toBe("deny");
    expect(evaluateGate({ ...base, rules: [terminal], origin: "cli" }).decision).toBe("ask");
    const web = rule({ ruleId: "w", toolPattern: "sandbox.run", decision: "deny", origin: "web" });
    expect(evaluateGate({ ...base, rules: [web], origin: "web" }).decision).toBe("deny");
    expect(evaluateGate({ ...base, rules: [web], origin: "ipc" }).decision).toBe("ask");
    expect(ruleAppliesTo(terminal, "web")).toBe(true);
    expect(ruleAppliesTo(rule({ ruleId: "m", toolPattern: "sandbox.run", decision: "deny", origin: "messaging" }), "web")).toBe(false);
    expect(ToolRuleSchema.safeParse({ ...web }).success).toBe(true);
  });

  it("holds a turn to the narrower of its task's origin and the channel it arrived through", () => {
    const profile = rule({ ruleId: "p", toolPattern: "sandbox.run", decision: "deny", origin: "messaging" });
    const webAllow = rule({ ruleId: "wa", toolPattern: "sandbox.run", decision: "allow", origin: "web" });
    const chatAllow = rule({ ruleId: "ma", toolPattern: "sandbox.run", decision: "allow", origin: "messaging" });
    // A canvas-started chat's turn sent from a messaging conversation is held to the messaging profile…
    expect(evaluateGate({ ...base, rules: [profile], origin: "web", channel: "messaging" }).decision).toBe("deny");
    // …and loses an allow scoped to the canvas alone.
    expect(evaluateGate({ ...base, rules: [webAllow], origin: "web", channel: "messaging" }).decision).toBe("ask");
    expect(evaluateGate({ ...base, rules: [webAllow], origin: "web" }).decision).toBe("allow");
    // An allow scoped to the channel never lifts what the task's origin is held to.
    expect(evaluateGate({ ...base, rules: [chatAllow], origin: "web", channel: "messaging" }).decision).toBe("ask");
    // A messaging-started chat stays under its profile whatever the channel.
    expect(evaluateGate({ ...base, rules: [profile], origin: "messaging", channel: "web" }).decision).toBe("deny");
    expect(ruleAppliesToTurn(profile, "web", undefined)).toBe(false);
    expect(ruleAppliesToTurn(profile, "web", "messaging")).toBe(true);
    expect(ruleAppliesToTurn(rule({ ruleId: "any", toolPattern: "sandbox.run", decision: "allow" }), "web", "messaging")).toBe(true);
  });

  it("holds a turn to the front end it was typed in as well as its task's origin", () => {
    const webDeny = rule({ ruleId: "wd", toolPattern: "sandbox.run", decision: "deny", origin: "web" });
    const webAsk = rule({ ruleId: "wk", toolPattern: "sandbox.run", decision: "ask", origin: "web" });
    const ipcAllow = rule({ ruleId: "ia", toolPattern: "sandbox.run", decision: "allow", origin: "ipc" });
    const webAllow = rule({ ruleId: "wa", toolPattern: "sandbox.run", decision: "allow", origin: "web" });
    // A Home `tavi chat` began (ipc) is held to a web-scoped deny for a turn typed in the canvas…
    expect(evaluateGate({ ...base, rules: [webDeny], origin: "ipc", frontEnd: "web" }).decision).toBe("deny");
    expect(evaluateGate({ ...base, rules: [webAsk], origin: "ipc", frontEnd: "web" }).decision).toBe("ask");
    // …which before applied to it only through its origin, never.
    expect(evaluateGate({ ...base, rules: [webDeny], origin: "ipc" }).decision).toBe("ask");
    expect(evaluateGate({ ...base, rules: [webDeny], origin: "ipc", frontEnd: "ipc" }).decision).toBe("ask");
    // An ipc-scoped allow covers web: a web turn of an ipc Home is allowed exactly as before.
    expect(evaluateGate({ ...base, rules: [ipcAllow], origin: "ipc", frontEnd: "web" }).decision).toBe("allow");
    expect(evaluateGate({ ...base, rules: [ipcAllow], origin: "ipc" }).decision).toBe("allow");
    // An ipc-scoped allow never lifts a web Home's turn past what web allowed: an ipc rule already covered web.
    expect(evaluateGate({ ...base, rules: [ipcAllow], origin: "web", frontEnd: "web" }).decision).toBe("allow");
    // A web-scoped allow lifts nothing in an ipc Home, from either front end.
    expect(evaluateGate({ ...base, rules: [webAllow], origin: "ipc", frontEnd: "web" }).decision).toBe("ask");
    expect(evaluateGate({ ...base, rules: [webAllow], origin: "ipc" }).decision).toBe("ask");
    // A web Home's turn typed at a terminal loses a web-only allow (narrower), keeps an ipc one.
    expect(evaluateGate({ ...base, rules: [webAllow], origin: "web", frontEnd: "ipc" }).decision).toBe("ask");
    expect(evaluateGate({ ...base, rules: [ipcAllow], origin: "web", frontEnd: "ipc" }).decision).toBe("allow");
    // With a messaging channel too, every one of them must cover an allow.
    expect(ruleAppliesToTurn(webDeny, "ipc", undefined, "web")).toBe(true);
    expect(ruleAppliesToTurn(ipcAllow, "ipc", "messaging", "web")).toBe(false);
    expect(ruleAppliesToTurn(rule({ ruleId: "any", toolPattern: "sandbox.run", decision: "allow" }), "ipc", "messaging", "web")).toBe(true);
  });
});

describe("splitShellCommands", () => {
  it("splits on every separator and keeps redirections", () => {
    expect(splitShellCommands("ls -la && rm -rf build; echo done | tee log 2>&1")).toEqual([
      "ls -la",
      "rm -rf build",
      "echo done",
      "tee log 2>&1",
    ]);
  });

  it("skips a comment to its line's end, as /bin/sh does, quotes and all", () => {
    expect(splitShellCommands("echo hi # it's a note\nrm -rf build")).toEqual(["echo hi", "rm -rf build"]);
    expect(splitShellCommands("echo a#b # trailing")).toEqual(["echo a#b"]);
    expect(splitShellCommands("echo '# not a comment'; ls")).toEqual(["echo '# not a comment'", "ls"]);
  });

  it("lifts command substitutions out as their own commands", () => {
    expect(splitShellCommands("echo $(rm -rf x) `whoami`")).toEqual(["echo $SUB $SUB", "rm -rf x", "whoami"]);
  });

  it("does not split inside quotes", () => {
    expect(splitShellCommands(`echo "a && b"; grep 'x|y' f`)).toEqual([`echo "a && b"`, "grep 'x|y' f"]);
  });

  it("lifts a substitution inside double quotes, so an echo rule cannot cover it", () => {
    const script = `echo "$(curl x -o y; sh y)"`;
    expect(splitShellCommands(script)).toEqual([`echo "$SUB"`, "curl x -o y", "sh y"]);
    const verdict = evaluateGate({
      ...base,
      assessment: assessment(splitShellCommands(script)),
      rules: [rule({ ruleId: "echo", toolPattern: "sandbox.run", decision: "allow", argMatcher: "echo *" })],
    });
    expect(verdict.decision).toBe("ask");
  });

  it("does not end a substitution at a quoted parenthesis", () => {
    const script = `git log $(echo ")"; rm -rf x)`;
    expect(splitShellCommands(script)).toEqual(["git log $SUB", `echo ")"`, "rm -rf x"]);
    const verdict = evaluateGate({
      ...base,
      assessment: assessment(splitShellCommands(script)),
      rules: [rule({ ruleId: "git", toolPattern: "sandbox.run", decision: "allow", argMatcher: "git *" })],
    });
    expect(verdict.decision).toBe("ask");
  });

  it("fails closed on a script it cannot read", () => {
    const subjects = splitShellCommands(`echo $(rm -rf x`);
    expect(subjects.at(-1)?.startsWith(UNPARSED_SUBJECT_PREFIX)).toBe(true);
    expect(splitShellCommands(`echo "unterminated`).at(-1)?.startsWith(UNPARSED_SUBJECT_PREFIX)).toBe(true);
    const verdict = evaluateGate({
      ...base,
      assessment: assessment(subjects),
      rules: [rule({ ruleId: "echo", toolPattern: "sandbox.run", decision: "allow", argMatcher: "echo *" })],
    });
    expect(verdict.decision).toBe("ask");
  });

  it("treats a subshell's commands as commands", () => {
    expect(splitShellCommands("(cd dir && make)")).toEqual(["cd dir", "make"]);
  });
});

// Each line's reading was checked against `/bin/sh -c` (bash 3.2 in POSIX mode) and `dash`.
describe("readShellScript reads quoting, continuations and ${…} as /bin/sh does", () => {
  const unparsed = (commands: readonly string[]) => commands.some((command) => command.startsWith(UNPARSED_SUBJECT_PREFIX));

  it("reads $'…' as ANSI-C quoting, where \\' does not close it", () => {
    // sh: prints `'`, runs touch, prints `'` (dash has no $'…': one echo, so the line is opaque either way).
    const reading = readShellScript(String.raw`echo $'\'' ; touch /tmp/x ; echo \'`);
    expect(reading.commands).toEqual([String.raw`echo $'\''`, "touch /tmp/x", String.raw`echo \'`]);
    expect(reading.opaque).toContain(SHELL_QUOTING_REASON);
    expect(readShellScript(`echo $"a;b"; ls`).commands).toEqual([`echo $"a;b"`, "ls"]);
  });

  it("does not read a quoted $ or a regex anchor as $'…'", () => {
    expect(readShellScript(`grep 'x$' f; echo "cost 5$"`)).toEqual({ commands: ["grep 'x$' f", `echo "cost 5$"`], opaque: [] });
  });

  it("joins a backslash-newline outside single quotes before reading a word", () => {
    // sh: `echo "$\⏎(uname)"` runs uname; `ech\⏎o hi` runs echo.
    const lifted = readShellScript('echo "$\\\n(uname)"');
    expect(lifted.commands).toEqual([`echo "$SUB"`, "uname"]);
    expect(lifted.opaque).toContain(SHELL_CONTINUATION_REASON);
    expect(splitShellCommands("r\\\nm -rf /")).toEqual(["rm -rf /"]);
    expect(splitShellCommands("ls &\\\n& wc")).toEqual(["ls", "wc"]);
    // Inside single quotes and $'…' it stays: sh prints `a\⏎b`.
    expect(readShellScript("echo 'a\\\nb'").opaque).toEqual([]);
  });

  it("keeps an escaped backslash before a newline: two commands, as sh runs them", () => {
    // sh: prints `\`, then runs the second line.
    expect(readShellScript("echo \\\\\nsudo rm -rf /tmp/x")).toEqual({ commands: ["echo \\\\", "sudo rm -rf /tmp/x"], opaque: [] });
    // A backslash before \r\n escapes the \r; the \n still ends the command.
    expect(splitShellCommands("echo a\\\r\nsudo ls")).toEqual(["echo a\\", "sudo ls"]);
  });

  it("does not join a comment's trailing backslash to the next line", () => {
    // sh: prints `a`, then runs the second line.
    expect(splitShellCommands("echo a #\\\nrm -rf build")).toEqual(["echo a", "rm -rf build"]);
  });

  it("reads a # right after a bare { or } as part of a word, not a comment", () => {
    // sh: prints `}#` (and `a{#`), then runs uname.
    expect(splitShellCommands("echo }#; uname")).toContain("uname");
    expect(splitShellCommands("echo a{#; uname")).toContain("uname");
    expect(splitShellCommands("echo ${x}}#; uname")).toContain("uname");
    // sh: a # after an operator or a space still starts a comment.
    expect(splitShellCommands("(echo a)#; uname")).toEqual(["echo a"]);
    expect(splitShellCommands("{ ls; } #; uname")).toEqual(["ls"]);
  });

  it("reads ${…} as one expansion, not a brace group or a comment", () => {
    // sh: prints 0, then runs the second command.
    const reading = readShellScript("echo ${#}; sudo rm -rf /tmp/x");
    expect(reading.commands).toEqual(["echo ${#}", "sudo rm -rf /tmp/x"]);
    expect(reading.opaque).toContain(SHELL_BRACED_EXPANSION_REASON);
    expect(readShellScript("sort a > ${TMPDIR}/out; echo ${1}")).toEqual({ commands: ["sort a > ${TMPDIR}/out", "echo ${1}"], opaque: [] });
    // A substitution inside one still runs.
    expect(splitShellCommands("echo ${x:-$(uname)}")).toEqual(["echo ${x:-$SUB}", "uname"]);
  });

  it("reads quotes nested in ${…} and fails closed on them", () => {
    // sh and dash: two empty lines around `uname`'s output, so three commands.
    const commands = splitShellCommands(`echo "\${x#'"'}"; uname; echo "\${y#"'"}"`);
    expect(commands.slice(0, 3)).toEqual([`echo "\${x#'"'}"`, "uname", `echo "\${y#"'"}"`]);
    expect(unparsed(commands)).toBe(true);
  });

  it("ends a substitution where /bin/sh does", () => {
    // sh: $'\')' is one word, so the substitution runs both commands.
    expect(splitShellCommands(String.raw`echo $(echo $'\')'; uname)`)).toEqual(["echo $SUB", String.raw`echo $'\')'`, "uname"]);
    // sh and dash: a `)` inside ${…} does not close it (and its quotes make the line unreadable).
    const braced = splitShellCommands(`echo $(echo \${x:-")"}; uname)`);
    expect(braced.slice(0, 3)).toEqual(["echo $SUB", `echo \${x:-")"}`, "uname"]);
    expect(unparsed(braced)).toBe(true);
    // sh: a backquoted body ends at the next backquote, even inside single quotes, and runs `uname`.
    expect(splitShellCommands("echo `echo '`; uname; echo '`'")).toContain("uname");
  });

  it("names a process substitution", () => {
    expect(readShellScript("diff <(ls a) <(ls b)").opaque).toEqual([SHELL_PROCESS_SUBSTITUTION_REASON]);
  });

  it("is never covered by an echo glob", () => {
    for (const script of [
      String.raw`echo $'\'' ; touch /tmp/x ; echo \'`,
      'echo "$\\\n(uname)"',
      "echo \\\\\nsudo rm -rf /tmp/x",
      "echo ${#}; sudo rm -rf /tmp/x",
      `echo "\${x#'"'}"; uname; echo "\${y#"'"}"`,
    ]) {
      const verdict = evaluateGate({
        ...base,
        assessment: assessment(splitShellCommands(script)),
        rules: [rule({ ruleId: "echo", toolPattern: "sandbox.run", decision: "allow", argMatcher: "echo *" })],
      });
      expect(verdict.decision, script).toBe("ask");
    }
  });
});

describe("resumeIntentIdentity", () => {
  it("treats a granted scope as content and attribution as not", () => {
    const once = resumeIntentIdentity({ approved: true, decidedBy: "alice", via: "telegram-main" });
    expect(resumeIntentIdentity({ approved: true, scope: "once", decidedBy: "bob", via: "ipc" })).toEqual(once);
    expect(resumeIntentIdentity({ approved: true, scope: "always" })).not.toEqual(once);
    expect(resumeIntentIdentity({ decisions: [{ callId: "c", approved: true, scope: "session" }] })).not.toEqual(
      resumeIntentIdentity({ decisions: [{ callId: "c", approved: true }] }),
    );
    // A rejection carries no scope.
    expect(resumeIntentIdentity({ approved: false, scope: "always" })).toEqual(resumeIntentIdentity({ approved: false }));
  });

  it("clips a verdict's display and reasons to the schema's bounds", () => {
    const long = `/${"p".repeat(400)}`;
    const verdict = evaluateGate({
      ...base,
      assessment: {
        display: { title: `Write ${long}`, detail: "d".repeat(3_000), host: long, destination: long, command: "c".repeat(5_000) },
        subjects: [],
        risk: "medium",
        reasons: [`changes ${long}`],
      },
    });
    expect(() => GateVerdictSchema.parse(verdict)).not.toThrow();
    expect(verdict.display.title).toHaveLength(300);
    expect(verdict.display.title.endsWith("…")).toBe(true);
    expect(verdict.risk.reasons[0]).toHaveLength(300);
  });
});

describe("the seeded reminder rule and taint", () => {
  const reminders = {
    ...base,
    toolId: "reminders.create",
    effect: "mutating" as const,
    rules: [seededReminderRule("default", "2026-09-30T00:00:00.000Z")],
  };
  const call = (askWhenTainted: boolean): CallAssessment => ({
    display: { title: "Remind: pills" },
    subjects: [],
    risk: "low",
    reasons: [],
    ...(askWhenTainted ? { askWhenTainted: true } : {}),
  });

  it("allows every reminder call by the seeded rule while the conversation is clean", () => {
    expect(evaluateGate({ ...reminders, assessment: call(false) })).toMatchObject({ decision: "allow", ruleId: "seeded-reminders" });
    expect(evaluateGate({ ...reminders, assessment: call(true) })).toMatchObject({ decision: "allow", ruleId: "seeded-reminders" });
  });

  it("asks for a call that starts a task, changes or cancels one when the conversation is tainted, and still allows a text-only reminder", () => {
    const asked = evaluateGate({ ...reminders, tainted: true, assessment: call(true) });
    expect(asked).toMatchObject({ decision: "ask", risk: { tainted: true } });
    expect(asked.allowedScopes).toEqual(["once"]);
    // Carried on the verdict for the approval request, so a schedule fire can deny it.
    expect(asked.askWhenTainted).toBe(true);
    expect(GateVerdictSchema.parse(asked)).toEqual(asked);
    expect(evaluateGate({ ...reminders, tainted: true, assessment: call(false) }).askWhenTainted).toBeUndefined();
    expect(evaluateGate({ ...reminders, tainted: true, assessment: call(false) })).toMatchObject({
      decision: "allow",
      ruleId: "seeded-reminders",
    });
    // A session grant does not lift it either.
    const grant = {
      grantId: "g",
      taskId: "t",
      workspaceId: "default",
      toolId: "reminders.create",
      approvalId: "a",
      createdBy: "p",
      createdAt: "2026-09-30T00:00:00.000Z",
    };
    expect(evaluateGate({ ...reminders, rules: [], sessionGrants: [grant], tainted: true, assessment: call(true) }).decision).toBe("ask");
  });

  it("is a stored operator rule a page can list and revoke", () => {
    expect(seededReminderRule("w1", "2026-09-30T00:00:00.000Z")).toMatchObject({
      ruleId: "seeded-reminders",
      workspaceId: "w1",
      toolPattern: "reminders.*",
      decision: "allow",
      source: "operator",
      createdVia: "config",
    });
  });

  it("each seeded rule's note says to remove it, the word its button and `tavi permissions rm` use", () => {
    for (const note of [REMINDER_ALLOW_RULE_NOTE, TODO_ALLOW_RULE_NOTE, WEB_SEARCH_ALLOW_RULE_NOTE, PROPOSAL_ALLOW_RULE_NOTE]) {
      expect(note).not.toMatch(/Revoke/);
      expect(note).toMatch(/Remove it to be asked each time\.$/);
    }
  });
});

describe("the taint step", () => {
  const at = "2026-10-13T00:00:00.000Z";
  const allow = (toolPattern: string, source: ToolRule["source"] = "operator"): ToolRule =>
    rule({ ruleId: `allow-${source}-${toolPattern}`, toolPattern, decision: "allow", source });
  const grant = (toolId: string): SessionGrant => ({
    grantId: `grant-${toolId}`,
    taskId: "t",
    workspaceId: "default",
    toolId,
    approvalId: "a",
    createdBy: "p",
    createdAt: at,
  });
  const call = (extra: Partial<CallAssessment> = {}): CallAssessment => ({ ...assessment([], "low"), ...extra });
  const known = new Set(["https://docs.example/guide", "https://docs.example/next", "https://docs.example/next#section-2"]);
  const tainted = (toolId: string, sink: GateEvaluationInput["sink"], extra: Partial<GateEvaluationInput> = {}): GateEvaluationInput => ({
    ...base,
    toolId,
    effect: "external",
    sink,
    tainted: true,
    knownUrls: known,
    ...extra,
  });
  /** Each way a person or an operator allows a call outside a round: none of them lifts the step. */
  const lifts = (toolId: string): readonly Partial<GateEvaluationInput>[] => [
    { rules: [allow(toolId)] },
    { sessionGrants: [grant(toolId)] },
    { rules: flagAllowRules([toolId]) },
    {},
  ];

  const rows: readonly {
    readonly name: string;
    readonly toolId: string;
    readonly sink: GateEvaluationInput["sink"];
    readonly assessment: CallAssessment;
    readonly reason: string;
  }[] = [
    {
      name: "a novel URL",
      toolId: "web_fetch",
      sink: "network",
      assessment: call({ urlOnly: true, urls: ["https://docs.example/c?d=secret"] }),
      reason: "novel-url",
    },
    {
      name: "a request with a payload",
      toolId: "http.request",
      sink: "network",
      assessment: call({ urlOnly: false }),
      reason: "tainted-payload",
    },
    {
      name: "a message to another destination",
      toolId: "messaging.send_to",
      sink: "message",
      assessment: call(),
      reason: "tainted-message",
    },
    {
      name: "a stored credential",
      toolId: "http.request",
      sink: "network",
      assessment: call({ sink: "credential" }),
      reason: "credential-under-taint",
    },
    { name: "a durable write", toolId: "routines.update", sink: "persist", assessment: call(), reason: "tainted-persist" },
    {
      name: "a browser session on the signed-in profile, even to a known page",
      toolId: "browser.create_session",
      sink: "network",
      assessment: call({ urlOnly: true, signedInProfile: true, browserSteps: [] }),
      reason: "signed-in-browser",
    },
    // `alwaysAnyCall` widens the scopes of an ordinary ask; it never lifts the step.
    {
      name: "an alwaysAnyCall call with a sink",
      toolId: "fixture.post",
      sink: "network",
      assessment: call({ alwaysAnyCall: true }),
      reason: "tainted-payload",
    },
  ];
  for (const row of rows) {
    it(`asks once about ${row.name}, under a rule, a grant, a flag rule and none`, () => {
      for (const lift of lifts(row.toolId)) {
        const verdict = evaluateGate({ ...tainted(row.toolId, row.sink), assessment: row.assessment, ...lift });
        expect(verdict, JSON.stringify(lift)).toMatchObject({
          decision: "ask",
          gateReason: row.reason,
          allowedScopes: ["once"],
          risk: { level: "high", tainted: true },
        });
        expect(GateVerdictSchema.parse(verdict)).toEqual(verdict);
      }
    });
  }

  it("leaves a signed-out browser session to the known-URL rule, and an untainted chat's signed-in one alone", () => {
    const known = new Set(["https://docs.example/"]);
    const signedOut = evaluateGate({
      ...tainted("browser.create_session", "network", { urlOnly: true, knownUrls: known, rules: [allow("browser.create_session")] }),
      assessment: call({
        urlOnly: true,
        urls: ["https://docs.example/"],
        browserSteps: [{ kind: "navigate", url: "https://docs.example/" }],
      }),
    });
    expect(signedOut.gateReason).toBeUndefined();
    expect(signedOut.decision).toBe("allow");
    const untainted = evaluateGate({
      ...tainted("browser.create_session", "network", { urlOnly: true, rules: [allow("browser.create_session")] }),
      tainted: false,
      assessment: call({ urlOnly: true, signedInProfile: true, browserSteps: [] }),
    });
    expect(untainted.gateReason).toBeUndefined();
    // A person approved the signed-in browser earlier in this task: a later session does not ask again for it.
    const approved = evaluateGate({
      ...tainted("browser.create_session", "network", { urlOnly: true, rules: [allow("browser.create_session")] }),
      signedInBrowserApproved: true,
      assessment: call({ urlOnly: true, signedInProfile: true, browserSteps: [] }),
    });
    expect(approved.gateReason).toBeUndefined();
  });

  it("records a novel URL in its normal form, for an approval to make known", () => {
    const verdict = evaluateGate({
      ...tainted("web_fetch", "network", { urlOnly: true }),
      assessment: call({ urls: ["HTTPS://Docs.Example:443/c?d=secret#x"] }),
    });
    expect(verdict).toMatchObject({ gateReason: "novel-url", urls: ["https://docs.example/c?d=secret"] });
  });

  it("skips a known URL, in any spelling of its normal form, and asks for a model-extended one", () => {
    const verdict = (url: string) =>
      evaluateGate({
        ...tainted("web_fetch", "network", { urlOnly: true, rules: [allow("web_fetch")] }),
        assessment: call({ urls: [url] }),
      });
    expect(verdict("https://docs.example/guide")).toMatchObject({ decision: "allow", ruleId: "allow-operator-web_fetch" });
    expect(verdict("HTTPS://DOCS.example:443/guide#top").gateReason).toBeUndefined();
    expect(verdict("https://docs.example/guide/").gateReason).toBe("novel-url");
    expect(verdict("https://docs.example/guide?q=1").gateReason).toBe("novel-url");
    // Longer than 2,048 characters: never known, and nothing to record.
    const long = verdict(`https://docs.example/${"a".repeat(2_100)}`);
    expect(long).toMatchObject({ decision: "ask", gateReason: "novel-url" });
    expect(long.urls).toBeUndefined();
    // A host's root: `https://a.example` and `https://a.example/` are one URL.
    expect(
      evaluateGate({
        ...tainted("web_fetch", "network", { urlOnly: true, knownUrls: new Set(["https://a.example/"]) }),
        assessment: call({ urls: ["https://a.example"] }),
      }).gateReason,
    ).toBeUndefined();
  });

  it("asks about a urlOnly call whose URLs were not read: no assessor, or one with no urls", () => {
    expect(evaluateGate({ ...tainted("web_fetch", "network", { urlOnly: true, rules: [allow("web_fetch")] }) })).toMatchObject({
      decision: "ask",
      gateReason: "novel-url",
      allowedScopes: ["once"],
    });
    const fallback = evaluateGate({
      ...tainted("web_fetch", "network", { urlOnly: true }),
      assessment: { display: { title: "Run web_fetch" }, subjects: [], risk: "high", reasons: ["the call could not be assessed"] },
    });
    expect(fallback).toMatchObject({ decision: "ask", gateReason: "novel-url" });
    expect(fallback.urls).toBeUndefined();
  });

  it("skips a URL the tool's own scope vouches for, as a heartbeat's watched page", () => {
    const verdict = evaluateGate({
      ...tainted("heartbeat.fetch", "network", { urlOnly: true, knownUrls: new Set() }),
      assessment: call({ urls: ["https://watched.example/p"], vouchedUrls: ["https://watched.example/p"] }),
    });
    expect(verdict.gateReason).toBeUndefined();
  });

  it("lets a reply, a search, a non-sink call and an explicit memory proposal through, and keeps today's treatment for them", () => {
    expect(evaluateGate({ ...tainted("messaging.send", "reply"), rules: SHIPPED_TOOL_RULES, assessment: call() })).toMatchObject({
      decision: "allow",
      ruleId: "shipped-messaging-send",
    });
    const search = evaluateGate({ ...tainted("web_search", "search"), assessment: call({ alwaysAnyCall: true }) });
    expect(search.gateReason).toBeUndefined();
    expect(search.allowedScopes).toEqual(["once", "session", "always"]);
    // A tainted call that is no sink: high, once and session, as before the step.
    const shell = evaluateGate({ ...tainted("sandbox.run", "none"), assessment: assessment(["ls"], "low") });
    expect(shell).toMatchObject({ decision: "ask", risk: { level: "high" }, allowedScopes: ["once", "session"] });
    expect(shell.gateReason).toBeUndefined();
    expect(
      evaluateGate({ ...tainted("memory.propose", "persist"), effect: "mutating", rules: [allow("memory.propose")], assessment: call() }),
    ).toMatchObject({ decision: "allow" });
  });

  it("narrows by the call's own sink: a write inside the managed folder is none", () => {
    expect(
      evaluateGate({ ...tainted("fs.write", "persist"), rules: [allow("fs.write")], assessment: call({ sink: "none" }) }),
    ).toMatchObject({ decision: "allow" });
    expect(
      evaluateGate({ ...tainted("fs.write", "persist"), rules: [allow("fs.write")], assessment: call({ askWhenTainted: true }) }),
    ).toMatchObject({ decision: "ask", gateReason: "tainted-persist", allowedScopes: ["once"] });
  });

  it("skips everything in a clean conversation", () => {
    expect(
      evaluateGate({ ...tainted("http.request", "network"), tainted: false, rules: [allow("http.request")], assessment: call() }),
    ).toMatchObject({ decision: "allow" });
  });

  it("lets a deny rule win, the messaging profile's included: refused, not asked", () => {
    const profile = rule({ ruleId: "messaging-no-http", toolPattern: "http.request", decision: "deny", origin: "messaging" });
    const verdict = evaluateGate({ ...tainted("http.request", "network"), rules: [profile], origin: "messaging", assessment: call() });
    expect(verdict).toMatchObject({ decision: "deny", ruleId: "messaging-no-http" });
    expect(verdict.gateReason).toBeUndefined();
  });

  it("still asks under an operator ask rule, and offers a critical call once only", () => {
    const asked = evaluateGate({
      ...tainted("http.request", "network"),
      rules: [rule({ ruleId: "ask-http", toolPattern: "http.request", decision: "ask" })],
      assessment: call(),
    });
    expect(asked).toMatchObject({ decision: "ask", allowedScopes: ["once"] });
    expect(evaluateGate({ ...tainted("http.request", "network"), assessment: call({ risk: "critical" }) })).toMatchObject({
      decision: "ask",
      allowedScopes: ["once"],
      risk: { level: "critical" },
    });
  });

  it("opens a page of a seen or allowed site by a path the person wrote, and nothing their words could carry out", () => {
    const siteGrant = { ...grant("browser.navigate"), argMatcher: "the-internet.example" };
    const personal = untrustedLabel("web", { principal: "host:attacker.example", confidentiality: "personal" });
    const browse = (browserSteps: readonly BrowserStep[], extra: Partial<GateEvaluationInput> = {}) =>
      evaluateGate({
        ...tainted("browser.navigate", "network"),
        rules: [allow("browser.*")],
        sessionGrants: [siteGrant],
        label: personal,
        personTexts: ["Open /login and /dynamic_loading/2 on the-internet.example. My licence is 4471-XY."],
        assessment: call({ browserSteps, scopeGroup: "browser.*" }),
        ...extra,
      });
    // Private data in the context or not: the path is the person's words, on a site they allowed or the chat has seen.
    expect(browse([{ kind: "navigate", url: "https://the-internet.example/dynamic_loading/2" }])).toMatchObject({ decision: "allow" });
    expect(browse([{ kind: "navigate", url: "https://the-internet.example/" }])).toMatchObject({ decision: "allow" });
    expect(browse([{ kind: "navigate", url: "https://docs.example/login" }])).toMatchObject({ decision: "allow" });
    // A path nobody wrote, a query or fragment, or a site neither seen nor allowed asks once, as before.
    for (const url of [
      "https://the-internet.example/secure",
      "https://the-internet.example/login?d=4471-XY",
      "https://the-internet.example/login#4471-XY",
      "https://collect.attacker.example/login",
    ]) {
      expect(browse([{ kind: "navigate", url }]), url).toMatchObject({ decision: "ask", gateReason: "novel-url", allowedScopes: ["once"] });
    }
    // The person's words are not theirs to type under taint: they may hold a secret an injected page asks for.
    expect(browse([{ kind: "type", url: "https://the-internet.example/login" }], { label: undefined })).toMatchObject({
      decision: "ask",
      gateReason: "tainted-payload",
      allowedScopes: ["once"],
    });
  });

  it("judges a browser call one step at a time", () => {
    const steps = (browserSteps: readonly BrowserStep[]) =>
      evaluateGate({
        ...tainted("browser.batch", "network"),
        rules: [allow("browser.*")],
        assessment: call({ browserSteps, scopeGroup: "browser.*" }),
      });
    // Clicks, scrolls and named keys skip; a submit, upload, download or press by sight asks once.
    expect(steps([{ kind: "inert" }, { kind: "inert" }])).toMatchObject({ decision: "allow" });
    expect(steps([{ kind: "send" }])).toMatchObject({ decision: "ask", gateReason: "tainted-payload", allowedScopes: ["once"] });
    // Typing on an origin the task reached through a known URL is allowed under [A] alone; elsewhere it asks.
    expect(steps([{ kind: "type", url: "https://docs.example/form" }])).toMatchObject({ decision: "allow" });
    // A page the tool cannot name is not established: typing there asks, failing safe.
    expect(steps([{ kind: "type" }])).toMatchObject({ decision: "ask", gateReason: "tainted-payload" });
    expect(steps([{ kind: "inert" }, { kind: "type", url: "https://elsewhere.example/form" }])).toMatchObject({
      decision: "ask",
      gateReason: "tainted-payload",
    });
    // A navigation is a urlOnly call, fragment included.
    expect(steps([{ kind: "navigate", url: "https://docs.example/next" }])).toMatchObject({ decision: "allow" });
    expect(steps([{ kind: "navigate", url: "https://docs.example/next#section-2" }])).toMatchObject({ decision: "allow" });
    // Recorded with its fragment, so a person's approval of it matches it next time.
    expect(steps([{ kind: "navigate", url: "https://docs.example/next#d=secret" }])).toMatchObject({
      decision: "ask",
      gateReason: "novel-url",
      urls: ["https://docs.example/next#d=secret"],
    });
    expect(
      evaluateGate({
        ...tainted("browser.navigate", "network", { knownUrls: new Set([...known, "https://docs.example/next#d=secret"]) }),
        assessment: call({ browserSteps: [{ kind: "navigate", url: "https://docs.example/next#d=secret" }] }),
      }).gateReason,
    ).toBeUndefined();
    expect(steps([{ kind: "navigate", url: "https://collect.attacker.example/?q=1" }])).toMatchObject({
      decision: "ask",
      gateReason: "novel-url",
    });
    // A submit under taint is the taint step's ask, once; with the step observed, the shipped ask rule's.
    const submit = {
      ...tainted("browser.act", "network"),
      rules: [...SHIPPED_TOOL_RULES, allow("browser.*")],
      assessment: call({ subjects: ["submit"], browserSteps: [{ kind: "send" }] }),
    };
    expect(evaluateGate(submit)).toMatchObject({ decision: "ask", gateReason: "tainted-payload", allowedScopes: ["once"] });
    expect(evaluateGate({ ...submit, taintMode: "observe" })).toMatchObject({
      decision: "ask",
      ruleId: "shipped-browser-submit",
      allowedScopes: ["once"],
      observedGateReason: "tainted-payload",
    });
  });

  it("refuses a tainted upload and a tainted act by sight in a run nobody attends, and asks once in an attended one", () => {
    const upload = evaluateGate({
      ...tainted("browser.act", "network"),
      rules: [...SHIPPED_TOOL_RULES, allow("browser.*")],
      assessment: call({ subjects: ["upload"], browserSteps: [{ kind: "send" }] }),
    });
    const bySight = evaluateGate({
      ...tainted("browser.vision_act", "network"),
      rules: [...SHIPPED_TOOL_RULES, allow("browser.*")],
      assessment: call({ risk: "high", browserSteps: [{ kind: "send" }] }),
    });
    for (const verdict of [upload, bySight]) {
      expect(verdict).toMatchObject({ decision: "ask", gateReason: "tainted-payload", allowedScopes: ["once"] });
      expect(
        unattendedDenial({ ...(verdict.gateReason === undefined ? {} : { gateReason: verdict.gateReason }), risk: verdict.risk }),
      ).toMatch(/untrusted content \(tainted-payload\)/);
    }
    // In a clean chat neither is the step's: the shipped rule decides, as before.
    expect(
      evaluateGate({
        ...tainted("browser.act", "network"),
        tainted: false,
        rules: [...SHIPPED_TOOL_RULES, allow("browser.*")],
        assessment: call({ subjects: ["upload"], browserSteps: [{ kind: "send" }] }),
      }).gateReason,
    ).toBeUndefined();
  });

  it("observes without enforcing, and is skipped when off", () => {
    const input = { ...tainted("http.request", "network"), rules: [allow("http.request")], assessment: call() };
    const observed = evaluateGate({ ...input, taintMode: "observe" });
    expect(observed).toMatchObject({ decision: "allow", observedGateReason: "tainted-payload" });
    expect(observed.gateReason).toBeUndefined();
    expect(GateVerdictSchema.parse(observed)).toEqual(observed);
    const off = evaluateGate({ ...input, taintMode: "off" });
    expect(off).toMatchObject({ decision: "allow" });
    expect(off.observedGateReason).toBeUndefined();
    // A call the step would not ask about records nothing.
    expect(evaluateGate({ ...input, taintMode: "observe", sink: "none" }).observedGateReason).toBeUndefined();
  });

  describe("with private data in the context ([A]∧[B])", () => {
    const personal = untrustedLabel("web", { principal: "host:attacker.example", confidentiality: "personal" });
    const publicTaint = untrustedLabel("web", { principal: "host:attacker.example" });

    it("asks once about a search under [A]∧[B], and not under [A] alone", () => {
      const search = (label: GateEvaluationInput["label"], extra: Partial<GateEvaluationInput> = {}) =>
        evaluateGate({
          ...tainted("web_search", "search"),
          label,
          rules: [allow("web_search")],
          assessment: call({ alwaysAnyCall: true }),
          ...extra,
        });
      for (const lift of lifts("web_search")) {
        const verdict = search(personal, lift);
        expect(verdict, JSON.stringify(lift)).toMatchObject({
          decision: "ask",
          gateReason: "private-search",
          allowedScopes: ["once"],
          risk: { level: "high", tainted: true, label: { confidentiality: "personal" } },
        });
        expect(GateVerdictSchema.parse(verdict)).toEqual(verdict);
      }
      expect(search(publicTaint)).toMatchObject({ decision: "allow" });
      expect(search(publicTaint).gateReason).toBeUndefined();
      // Private data alone, with nothing untrusted, is no taint: the step skips.
      expect(search(trustedLabel("personal"), { tainted: false }).gateReason).toBeUndefined();
      // A caller with no label reads as [A] alone.
      expect(
        evaluateGate({ ...tainted("web_search", "search"), rules: [allow("web_search")], assessment: call() }).gateReason,
      ).toBeUndefined();
    });

    it("asks once about a group or topic reply under [A]∧[B]; a one-to-one reply, or [A] alone, goes", () => {
      const reply = (label: GateEvaluationInput["label"], groupDestination: boolean) =>
        evaluateGate({
          ...tainted("messaging.send", "reply"),
          label,
          rules: SHIPPED_TOOL_RULES,
          assessment: call(groupDestination ? { groupDestination: true } : {}),
        });
      expect(reply(personal, true)).toMatchObject({ decision: "ask", gateReason: "private-group-reply", allowedScopes: ["once"] });
      expect(reply(personal, false)).toMatchObject({ decision: "allow", ruleId: "shipped-messaging-send" });
      expect(reply(publicTaint, true)).toMatchObject({ decision: "allow", ruleId: "shipped-messaging-send" });
      expect(
        evaluateGate({
          ...tainted("messaging.send", "reply"),
          tainted: false,
          label: trustedLabel("secret"),
          rules: SHIPPED_TOOL_RULES,
          assessment: call({ groupDestination: true }),
        }),
      ).toMatchObject({ decision: "allow" });
    });

    it("asks once about every browser typing step under [A]∧[B], even on a known origin", () => {
      const steps = (label: GateEvaluationInput["label"], browserSteps: readonly BrowserStep[]) =>
        evaluateGate({
          ...tainted("browser.batch", "network"),
          label,
          rules: [allow("browser.*")],
          assessment: call({ browserSteps, scopeGroup: "browser.*" }),
        });
      expect(steps(personal, [{ kind: "type", url: "https://docs.example/form" }])).toMatchObject({
        decision: "ask",
        gateReason: "tainted-payload",
        allowedScopes: ["once"],
      });
      expect(steps(publicTaint, [{ kind: "type", url: "https://docs.example/form" }])).toMatchObject({ decision: "allow" });
      // Clicks and known navigations are judged as under [A] alone.
      expect(steps(personal, [{ kind: "inert" }, { kind: "navigate", url: "https://docs.example/next" }])).toMatchObject({
        decision: "allow",
      });
    });
  });

  it("leaves a tool with no sink to today's rules, askWhenTainted included", () => {
    const { sink: _sink, ...noSink } = tainted("reminders.create", undefined);
    expect(evaluateGate({ ...noSink, rules: [seededReminderRule("default", at)], assessment: call() })).toMatchObject({
      decision: "allow",
    });
    expect(
      evaluateGate({ ...noSink, rules: [seededReminderRule("default", at)], assessment: call({ askWhenTainted: true }) }),
    ).toMatchObject({ decision: "ask", allowedScopes: ["once"] });
  });
});

describe("unattendedDenial — what a schedule fire denies whatever its tool list", () => {
  const risk = (level: "low" | "high" | "critical", tainted: boolean) => ({ level, reasons: [], tainted });

  it("denies a taint-step ask, a tainted askWhenTainted call and a critical call", () => {
    expect(unattendedDenial({ gateReason: "novel-url", tainted: true, risk: risk("high", true) })).toMatch(
      /untrusted content \(novel-url\)/,
    );
    expect(unattendedDenial({ tainted: true, askWhenTainted: true, risk: risk("high", true) })).toMatch(/asks a person/);
    // The verdict's own taint flag is read when the entry's is absent.
    expect(unattendedDenial({ askWhenTainted: true, risk: risk("high", true) })).toMatch(/asks a person/);
    expect(unattendedDenial({ tainted: false, risk: risk("critical", false) })).toMatch(/critical/);
  });

  it("denies a call only a person decides, clean or not, and carries the flag from the assessment to the verdict", () => {
    expect(unattendedDenial({ attendedOnly: true, tainted: false, risk: risk("low", false) })).toMatch(
      /a person reviews this call themselves/,
    );
    const verdict = evaluateGate({
      toolId: "pdf.fill",
      effect: "mutating",
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(["mutating"]),
      tainted: false,
      assessment: { display: { title: "Fill the form" }, subjects: [], risk: "medium", reasons: [], onceOnly: true, attendedOnly: true },
    });
    expect(verdict.attendedOnly).toBe(true);
    expect(GateVerdictSchema.parse(verdict).attendedOnly).toBe(true);
    expect(unattendedDenial(verdict)).toMatch(/a person reviews/);
    // Asked once even past an allow rule and a session grant, and with mutating calls ungated; a deny rule still refuses.
    const allowAll = [rule({ ruleId: "allow-fill", toolPattern: "pdf.fill", decision: "allow" })];
    const lifted = evaluateGate({
      toolId: "pdf.fill",
      effect: "mutating",
      rules: allowAll,
      sessionGrants: [],
      gatedEffects: new Set(),
      tainted: false,
      assessment: { display: { title: "Fill" }, subjects: [], risk: "medium", reasons: [], onceOnly: true, attendedOnly: true },
    });
    expect(lifted).toMatchObject({ decision: "ask", allowedScopes: ["once"], attendedOnly: true });
    const refused = evaluateGate({
      toolId: "pdf.fill",
      effect: "mutating",
      rules: [rule({ ruleId: "no-fill", toolPattern: "pdf.fill", decision: "deny" })],
      sessionGrants: [],
      gatedEffects: new Set(),
      tainted: false,
      assessment: { display: { title: "Fill" }, subjects: [], risk: "medium", reasons: [], attendedOnly: true },
    });
    expect(refused.decision).toBe("deny");
  });

  it("raises a call's effect by its assessment, never lowers it, and keeps the raise on the verdict", () => {
    expect(effectiveEffect("read-only", "external")).toBe("external");
    expect(effectiveEffect("external", "read-only")).toBe("external");
    expect(effectiveEffect("mutating", undefined)).toBe("mutating");
    const assessment = { display: { title: "Analyse the video" }, subjects: [], risk: "medium" as const, reasons: [] };
    // External calls gated: the raised read is asked, and its verdict says why.
    const raised = evaluateGate({
      toolId: "video.pose",
      effect: "read-only",
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(["external"]),
      tainted: false,
      assessment: { ...assessment, effect: "external" },
    });
    expect(raised).toMatchObject({ decision: "ask", effect: "external" });
    expect(GateVerdictSchema.parse(raised).effect).toBe("external");
    // A lowering is ignored: the write is still gated as a write, and its verdict names no effect of its own.
    const lowered = evaluateGate({
      toolId: "fs.write",
      effect: "mutating",
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(["mutating"]),
      tainted: false,
      assessment: { ...assessment, effect: "read-only" },
    });
    expect(lowered.decision).toBe("ask");
    expect(lowered.effect).toBeUndefined();
    expect(
      evaluateGate({
        toolId: "video.pose",
        effect: "read-only",
        rules: [],
        sessionGrants: [],
        gatedEffects: new Set(["external"]),
        tainted: false,
        assessment,
      }).decision,
    ).toBe("allow");
  });

  it("leaves a clean, non-critical call, and an entry from before the fields, to the tool list", () => {
    expect(unattendedDenial({ tainted: false, askWhenTainted: true, risk: risk("high", false) })).toBeUndefined();
    expect(unattendedDenial({ tainted: true, risk: risk("high", true) })).toBeUndefined();
    expect(unattendedDenial({})).toBeUndefined();
  });
});

describe("scheduling tools in a schedule's list", () => {
  it("refuses an entry that reaches a schedule or routine write, naming the read-only ones of its family", () => {
    for (const pattern of ["routines.create", "routines.*", "schedules.create", "schedules.*", "schedules.cancel", "routines.run"])
      expect(reachesSchedulingWrite(pattern), pattern).toBe(true);
    expect(schedulingPatternRefusal("routines.*")).toBe(
      '--allow "routines.*" is refused: a scheduled run never creates or changes schedules or routines; name the read-only ones it may use instead (routines.get, routines.list, routines.history, routines.inspect, routines.targets)',
    );
    expect(schedulingPatternRefusal("schedules.create")).toMatch(/instead \(schedules\.list, schedules\.history\)$/);
    // An unknown id of those families is refused too: a later tool there could write.
    expect(schedulingPatternRefusal("routines.something_new")).toBeDefined();
  });

  it("does not refuse a stored list's retired read-only routine tools as writes", () => {
    for (const retired of RETIRED_SCHEDULING_READS) {
      expect(SCHEDULING_READ_ONLY_TOOLS).not.toContain(retired);
      expect(reachesSchedulingWrite(retired), retired).toBe(false);
      expect(schedulingPatternRefusal(retired)).toBeUndefined();
      expect(scheduledWorkDenial(retired)).toBeUndefined();
    }
  });

  it("lets the read-only ones and every other family through, and leaves `*` to its own refusal", () => {
    for (const pattern of [
      "schedules.list",
      "schedules.history",
      "routines.list",
      "routines.get",
      "reminders.*",
      "reminders.create",
      "reports.*",
      "routine.x",
      "web_*",
    ]) {
      expect(reachesSchedulingWrite(pattern), pattern).toBe(false);
      expect(schedulingPatternRefusal(pattern), pattern).toBeUndefined();
    }
    expect(schedulingPatternRefusal("*")).toBeUndefined();
  });

  it("gives a fire's denial for a listed scheduling write, and none for a read", () => {
    expect(scheduledWorkDenial("routines.create")).toBe(
      "denied: a scheduled run never creates or changes schedules or routines, whatever its tool list says",
    );
    expect(scheduledWorkDenial("schedules.list")).toBeUndefined();
    expect(scheduledWorkDenial("reminders.create")).toBeUndefined();
  });
});

describe("an injection-detector hit", () => {
  const base: GateEvaluationInput = {
    toolId: "http.request",
    effect: "external",
    rules: [],
    sessionGrants: [],
    gatedEffects: new Set(["external"]),
    tainted: true,
    label: untrustedLabel("web"),
    sink: "network",
    urlOnly: true,
    taintMode: "enforce",
  };
  const reason = injectionWarningReason("web", ["override", "conceal"]);

  it("adds its reason and raises the risk to high, and changes nothing else", () => {
    const inputs: GateEvaluationInput[] = [
      base,
      { ...base, tainted: false, label: undefined, taintMode: "off" },
      { ...base, rules: [rule({ ruleId: "allow", toolPattern: "http.request", decision: "allow" })], tainted: false, label: undefined },
      { ...base, rules: [rule({ ruleId: "deny", toolPattern: "http.request", decision: "deny" })] },
      { ...base, assessment: { display: { title: "x" }, subjects: [], risk: "critical", reasons: [] } },
      { ...base, effect: "read-only", sink: "none", tainted: false, label: undefined },
    ];
    for (const input of inputs) {
      const verdict = evaluateGate(input);
      const warned = withInjectionWarning(verdict, [reason]);
      expect(GateVerdictSchema.parse(warned)).toEqual(warned);
      // The decision and everything that makes it are the verdict's own.
      const { risk: _risk, ...rest } = warned;
      const { risk: _before, ...restBefore } = verdict;
      expect(rest).toEqual(restBefore);
      expect(warned.risk.tainted).toBe(verdict.risk.tainted);
      expect(warned.risk.label).toEqual(verdict.risk.label);
      // Raised, never lowered: a critical call stays critical.
      expect(warned.risk.level).toBe(verdict.risk.level === "critical" ? "critical" : "high");
      expect(warned.risk.reasons.filter(isInjectionWarning)).toEqual([reason]);
      // Idempotent: a second hit of the same reason adds nothing.
      expect(withInjectionWarning(warned, [reason])).toBe(warned);
    }
    expect(withInjectionWarning(evaluateGate(base), [])).toEqual(evaluateGate(base));
    expect(reason).toBe("possible prompt injection in web content (override, conceal)");
  });

  it("keeps the warning when the reasons list is full, giving up the oldest other reason", () => {
    const verdict = evaluateGate(base);
    const full: GateVerdict = {
      ...verdict,
      risk: { ...verdict.risk, reasons: Array.from({ length: 16 }, (_, index) => `reason ${index}`) },
    };
    const warned = withInjectionWarning(full, [reason]);
    expect(warned.risk.reasons).toHaveLength(16);
    expect(warned.risk.reasons.at(-1)).toBe(reason);
    expect(warned.risk.reasons[0]).toBe("reason 1");
    const many = Array.from({ length: 20 }, (_, index) => injectionWarningReason("web", [`signal ${index}`]));
    const flooded = withInjectionWarning(full, many);
    expect(GateVerdictSchema.parse(flooded)).toEqual(flooded);
    expect(flooded.risk.reasons.every(isInjectionWarning)).toBe(true);
  });
});

describe("tool media references", () => {
  it("reads one reference, or a list of at most three, of images only", () => {
    const page = (id: string, mediaType = "image/png") => ({ artifactId: id, mediaType });
    expect(toolMediaListOf({ taviMedia: page("a") })).toEqual([page("a")]);
    expect(toolMediaListOf({ taviMedia: [page("a"), page("b"), page("c")] })).toEqual([page("a"), page("b"), page("c")]);
    expect(toolMediaListOf({ taviMedia: [page("a"), page("b"), page("c"), page("d")] })).toEqual([]);
    expect(toolMediaListOf({ taviMedia: [page("a"), page("b", "application/pdf")] })).toEqual([]);
    expect(toolMediaListOf({ taviMedia: [] })).toEqual([]);
    expect(toolMediaOf({ taviMedia: [page("a"), page("b")] })).toEqual(page("a"));
    expect(toolMediaOf({ taviMedia: page("doc", "application/pdf") })).toBeUndefined();
  });
});

describe("a form fill's card", () => {
  const row = (index: number, length = 20) => ({
    page: 1,
    field: `Field ${index}`,
    value: "v".repeat(length),
    source: 'leo.yaml: "x"',
    status: "verified" as const,
  });
  const form = (rows: ReturnType<typeof row>[]) => ({
    source: "packet.pdf, 10 pages",
    output: "forms/packet-filled.pdf",
    rows,
    leftBlank: [{ field: "Parent signature", why: "signature-like" as const }],
    warnings: ["hidden text on page 3"],
  });

  it("passes a form through the gate's display and survives the verdict schema, with the checked statuses", () => {
    const verdict = evaluateGate({
      toolId: "pdf.fill",
      effect: "mutating",
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(["mutating"]),
      tainted: false,
      assessment: {
        display: { title: "Fill the packet", form: form([row(1), row(2)]) },
        subjects: [],
        risk: "medium",
        reasons: [],
        attendedOnly: true,
      },
    });
    expect(verdict.display.form?.rows).toHaveLength(2);
    const checked = { ...verdict, sourceChecks: ["verified", "unmatched"] as const };
    expect(GateVerdictSchema.parse(checked)).toEqual(checked);
  });

  it("cuts rows past the card's budget and marks the form truncated", () => {
    const big = clipForm(form(Array.from({ length: 512 }, (_, index) => row(index, 200))));
    expect(big.truncated).toBe(true);
    expect(big.rows.length).toBeLessThan(512);
    expect(JSON.stringify(big).length).toBeLessThan(APPROVAL_FORM_BUDGET * 2);
    const small = clipForm(form([row(1)]));
    expect(small.truncated).toBeUndefined();
    expect(small.leftBlank).toEqual([{ field: "Parent signature", why: "signature-like" }]);
    // 220 rows of 218 characters leave 40 of the budget; a 40-character field left for the person needs 48.
    const rows = Array.from({ length: 220 }, () => ({
      page: 1,
      field: "F",
      value: "v".repeat(200),
      source: "s",
      status: "verified" as const,
    }));
    const full = clipForm({ ...form([]), rows, leftBlank: [{ field: "x".repeat(40), why: "signature" }] });
    expect(full.rows).toHaveLength(220);
    expect(full.leftBlank).toEqual([]);
    expect(full.truncated).toBe(true);
    expect(
      clipForm({ ...form([]), leftBlank: Array.from({ length: 257 }, () => ({ field: "f", why: "signature" as const })) }).truncated,
    ).toBe(true);
  });
});

describe("a grouped call held to the host it acts on", () => {
  const grant = (grantId: string, toolId: string, argMatcher?: string): SessionGrant => ({
    grantId,
    taskId: "t",
    workspaceId: "default",
    toolId,
    ...(argMatcher === undefined ? {} : { argMatcher }),
    approvalId: "a",
    createdBy: "alice",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  const act = (host: string | undefined): CallAssessment => ({
    display: { title: "Click" },
    subjects: ["click"],
    risk: "medium",
    reasons: [],
    scopeGroup: "browser.*",
    ...(host === undefined ? {} : { scopeHost: host }),
  });
  const input = (
    host: string | undefined,
    sessionGrants: readonly SessionGrant[],
    rules: readonly ToolRule[] = [],
  ): GateEvaluationInput => ({
    ...base,
    toolId: "browser.act",
    effect: "external",
    assessment: act(host),
    sessionGrants: [...sessionGrants],
    rules: [...rules],
  });

  it("holds a call asked about on its own to its host when it runs, and scopes no grant by it", () => {
    const submit: CallAssessment = {
      display: { title: "Submit" },
      subjects: ["submit"],
      risk: "high",
      reasons: [],
      scopeHost: "shop.example",
    };
    const verdict = evaluateGate({ ...input(undefined, []), assessment: submit });
    expect(verdict).toMatchObject({ decision: "ask", decidedHosts: ["shop.example"] });
    expect(verdict.scopeHosts).toBeUndefined();
  });

  it("is covered only by a grant for its host, never by one that named none", () => {
    expect(evaluateGate(input("example.com", [grant("g1", "browser.act", "example.com")]))).toMatchObject({
      decision: "allow",
      ruleId: "g1",
      scopeHosts: ["example.com"],
    });
    expect(evaluateGate(input("other.example", [grant("g1", "browser.act", "example.com")])).decision).toBe("ask");
    expect(evaluateGate(input("other.example", [grant("g2", "browser.act")])).decision).toBe("ask");
  });

  it("decides a call on frames of other sites for every host it acts on: each must be granted, and a rule on any holds it", () => {
    const batch = (sessionGrants: readonly SessionGrant[], rules: readonly ToolRule[] = []) =>
      evaluateGate({
        ...input("example.com", sessionGrants, rules),
        toolId: "browser.batch",
        assessment: { ...act("example.com"), additionalHosts: ["pay.example", "example.com", ""] },
      });
    const asked = batch([grant("g1", "browser.batch", "example.com")]);
    expect(asked).toMatchObject({ decision: "ask", scopeHosts: ["example.com", "pay.example"] });
    expect(batch([grant("g1", "browser.batch", "example.com"), grant("g2", "browser.batch", "pay.example")])).toMatchObject({
      decision: "allow",
      ruleId: "g1",
    });
    expect(batch([], [rule({ ruleId: "a", toolPattern: "browser.batch", argMatcher: "example.com", decision: "allow" })]).decision).toBe(
      "ask",
    );
    expect(batch([], [rule({ ruleId: "d", toolPattern: "browser.batch", argMatcher: "pay.example", decision: "deny" })]).decision).toBe(
      "deny",
    );
    // Asked about on its own, it is held to all of them when it runs.
    const submit = evaluateGate({
      ...input(undefined, []),
      assessment: {
        display: { title: "Drag" },
        subjects: ["drag"],
        risk: "high",
        reasons: [],
        scopeHost: "example.com",
        additionalHosts: ["pay.example"],
      },
    });
    expect(submit.decidedHosts).toEqual(["example.com", "pay.example"]);
  });

  it("refuses a call on more hosts, or longer ones, than one decision can name, rather than dropping any", () => {
    const many = Array.from({ length: 32 }, (_, index) => `f${index}.example`);
    const batch = (additionalHosts: readonly string[]) =>
      evaluateGate({
        ...input("example.com", [grant("g1", "browser.batch", "*")]),
        toolId: "browser.batch",
        assessment: { ...act("example.com"), additionalHosts },
      });
    expect(batch(many.slice(0, 31)).decision).toBe("allow");
    expect(batch(many)).toMatchObject({ decision: "deny", ruleId: "hard-deny" });
    expect(batch(["x".repeat(600)])).toMatchObject({ decision: "deny", ruleId: "hard-deny" });
  });

  it("lets a rule name the host, to allow or to deny", () => {
    expect(
      evaluateGate(
        input("example.com", [], [rule({ ruleId: "r", toolPattern: "browser.act", argMatcher: "example.com", decision: "allow" })]),
      ).decision,
    ).toBe("allow");
    expect(
      evaluateGate(
        input("evil.example", [], [rule({ ruleId: "d", toolPattern: "browser.act", argMatcher: "evil.example", decision: "deny" })]),
      ).decision,
    ).toBe("deny");
    expect(evaluateGate(input("example.com", [], [rule({ ruleId: "any", toolPattern: "browser.*", decision: "allow" })])).decision).toBe(
      "allow",
    );
  });

  it("never lets an approval's grant or rule for any call of a browser tool cover a host it did not name", () => {
    const navigate = (sessionGrants: readonly SessionGrant[], rules: readonly ToolRule[] = []) =>
      evaluateGate({
        ...base,
        toolId: "browser.navigate",
        effect: "external",
        sink: "network",
        urlOnly: true,
        assessment: { display: { title: "Open" }, subjects: ["attacker.example"], risk: "medium", reasons: [], scopeGroup: "browser.*" },
        sessionGrants: [...sessionGrants],
        rules: [...rules],
      });
    // An earlier build wrote matcher-less grants and `browser.*` rules from one approval.
    expect(navigate([grant("old", "browser.navigate")]).decision).toBe("ask");
    const approvalRule = rule({
      ruleId: `rule-${"a".repeat(40)}-0`,
      toolPattern: "browser.*",
      decision: "allow",
      createdVia: "channel",
      note: "approved always in round 2 of task t",
    });
    expect(navigate([], [approvalRule]).decision).toBe("ask");
    // The structured marker, whatever the note says.
    expect(
      navigate(
        [],
        [rule({ ruleId: "rule-marked", toolPattern: "browser.*", decision: "allow", createdVia: "ipc", fromApproval: true, note: "kept" })],
      ).decision,
    ).toBe("ask");
    expect(evaluateGate(input("example.com", [], [approvalRule])).decision).toBe("ask");
    // A rule an operator wrote (`permissions add`, `serve --allow`) still allows the tool as a whole.
    expect(navigate([], [rule({ ruleId: "rule-op", toolPattern: "browser.*", decision: "allow", createdVia: "cli" })]).decision).toBe(
      "allow",
    );
    expect(
      navigate([], [rule({ ruleId: "flag", toolPattern: "browser.navigate", decision: "allow", source: "flag", createdVia: "config" })])
        .decision,
    ).toBe("allow");
  });

  it("names a URL-only call's destinations as the hosts a decision allows", () => {
    const navigate = evaluateGate({
      ...base,
      toolId: "browser.navigate",
      effect: "external",
      sink: "network",
      urlOnly: true,
      assessment: { display: { title: "Open" }, subjects: ["example.com"], risk: "medium", reasons: [], scopeGroup: "browser.*" },
    });
    expect(navigate.scopeHosts).toEqual(["example.com"]);
    // A closing call has nothing to match: any grant for its tool covers it.
    expect(
      evaluateGate({
        ...base,
        toolId: "browser.close",
        effect: "mutating",
        assessment: { display: { title: "Close" }, subjects: [], risk: "low", reasons: [], scopeGroup: "browser.*" },
        sessionGrants: [grant("g3", "browser.close", "example.com")],
      }).decision,
    ).toBe("allow");
  });
});

describe("tool annotations", () => {
  it("are derived from the effect where a tool states none, and a read-only tool is never destructive", () => {
    expect(toolAnnotationsOf({ effect: "read-only" })).toEqual({ readOnly: true, destructive: false, idempotent: true, openWorld: false });
    expect(toolAnnotationsOf({ effect: "external" })).toEqual({ readOnly: false, destructive: false, idempotent: false, openWorld: true });
    expect(toolAnnotationsOf({ effect: "mutating", annotations: { destructive: true, idempotent: true } })).toMatchObject({
      destructive: true,
      idempotent: true,
    });
    expect(toolAnnotationsOf({ effect: "read-only", annotations: { destructive: true } }).destructive).toBe(false);
  });
});
