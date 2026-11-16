import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModelPort } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { DEFAULT_EVALUATION_BUDGET, DEFAULT_EVALUATION_THRESHOLDS, loadRoutineCorpus } from "@tavi/runtime";
import { liveEvalConfigFromEnv, liveEvalTracePath, liveEvaluationVerdict } from "./support/routine-live-eval.js";
import { RoutineService } from "../src/routines/service.js";
import { routineEvaluation, routineStore } from "./routine-evaluation-fixture.js";

/**
 * The routine quality gate's opt-in live harness.
 *
 * **Skipped by default.** A live run spends the operator's money against a named
 * provider, so it runs only when `TAVI_LIVE_EVAL=1` *and* the provider, the model
 * and a key **file** are all stated. There is deliberately no way to pass a key on
 * the command line or straight through the environment: `argv` lands in shell
 * history and `ps`, and an env var leaks into every child process.
 *
 * The parts that decide whether a live result counts — configuration and the
 * completeness verdict — are pure functions in `@tavi/runtime` and are tested
 * offline below. Everything that touches a network lives in the skipped block, so
 * this file can never spend anything by accident and its contract is still
 * covered.
 *
 * What a live run measures, per repetition:
 *   1. the labelled evaluation for both roles, recording precision, recall, model
 *      calls and tokens.
 *
 * The full routine run (research → synthesis → render → publication) and the
 * optional `TAVI_LIVE_EVAL_TELEGRAM=1` send are **not** part of this harness yet,
 * and neither is a recorded latency field: the body stops once `evaluation.drain()`
 * returns, and `latencyMs` from the port is not carried into the summary. A live
 * run's result is the labelled evaluation and nothing more.
 *
 * Results are written under `.evidence/routines/` (gitignored) and the summary is
 * produced by `evals/routines/score-live-eval.mjs`.
 */

const corpus = loadRoutineCorpus();

it("refuses to configure a live run from anything but an explicit file credential", () => {
  expect(liveEvalConfigFromEnv({})).toMatchObject({ ok: false, reason: expect.stringContaining("TAVI_LIVE_EVAL=1 is required") });
  expect(liveEvalConfigFromEnv({ TAVI_LIVE_EVAL: "1" })).toMatchObject({ ok: false, reason: expect.stringContaining("BASE_URL") });
  expect(liveEvalConfigFromEnv({ TAVI_LIVE_EVAL: "1", TAVI_LIVE_EVAL_BASE_URL: "http://127.0.0.1:1/v1" })).toMatchObject({
    ok: false,
    reason: expect.stringContaining("MODEL"),
  });
  expect(
    liveEvalConfigFromEnv({ TAVI_LIVE_EVAL: "1", TAVI_LIVE_EVAL_BASE_URL: "http://127.0.0.1:1/v1", TAVI_LIVE_EVAL_MODEL: "m" }),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("API_KEY_FILE") });
  // A key in the environment is refused outright rather than used.
  expect(
    liveEvalConfigFromEnv({
      TAVI_LIVE_EVAL: "1",
      TAVI_LIVE_EVAL_BASE_URL: "http://127.0.0.1:1/v1",
      TAVI_LIVE_EVAL_MODEL: "m",
      TAVI_LIVE_EVAL_API_KEY_FILE: "/tmp/key",
      TAVI_LIVE_EVAL_API_KEY: "sk-secret",
    }),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("refused") });
  expect(
    liveEvalConfigFromEnv({
      TAVI_LIVE_EVAL: "1",
      TAVI_LIVE_EVAL_BASE_URL: "http://127.0.0.1:1/v1",
      TAVI_LIVE_EVAL_MODEL: "m",
      TAVI_LIVE_EVAL_API_KEY_FILE: "/tmp/key",
      TAVI_LIVE_EVAL_REPS: "0",
    }),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("REPS") });
  expect(
    liveEvalConfigFromEnv({
      TAVI_LIVE_EVAL: "1",
      TAVI_LIVE_EVAL_BASE_URL: "http://127.0.0.1:1/v1",
      TAVI_LIVE_EVAL_MODEL: "m",
      TAVI_LIVE_EVAL_API_KEY_FILE: "/tmp/key",
      TAVI_LIVE_EVAL_CALL_CEILING: "999999",
    }),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("CEILING") });
  const ok = liveEvalConfigFromEnv({
    TAVI_LIVE_EVAL: "1",
    TAVI_LIVE_EVAL_BASE_URL: "http://127.0.0.1:1/v1",
    TAVI_LIVE_EVAL_MODEL: "m",
    TAVI_LIVE_EVAL_API_KEY_FILE: "/tmp/key",
  });
  expect(ok).toEqual({
    ok: true,
    config: {
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      apiKeyFile: "/tmp/key",
      reps: 1,
      callCeiling: 200,
      traceDirectory: ".evidence/routines",
    },
  });
  if (ok.ok) expect(liveEvalTracePath(ok.config, 2, "20260921T000000")).toBe(".evidence/routines/live-eval-20260921T000000-rep2.json");
});

it("calls a live run complete only when every sampled case, in both roles, was scored", () => {
  const expected = 3;
  expect(
    liveEvaluationVerdict([
      { repetition: 1, role: "research", expected, scored: 0 },
      { repetition: 1, role: "synthesis", expected, scored: 0 },
    ]),
  ).toMatchObject({ complete: false, scored: 0, expected: 6 });
  // One missing case is enough: a ceiling that stopped the run early is not a
  // smaller measurement, it is no measurement.
  expect(
    liveEvaluationVerdict([
      { repetition: 1, role: "research", expected, scored: 2 },
      { repetition: 1, role: "synthesis", expected, scored: 3 },
    ]),
  ).toMatchObject({ complete: false, scored: 5, expected: 6, missing: ["1:research (1 of 3 unscored)"] });
  expect(
    liveEvaluationVerdict([
      { repetition: 1, role: "research", expected, scored: 3 },
      { repetition: 1, role: "synthesis", expected, scored: 3 },
    ]),
  ).toMatchObject({ complete: true, scored: 6, expected: 6, missing: [] });
  // A later repetition counts too: a run that completed rep 1 and half of rep 2 is
  // incomplete, not an average over what finished.
  expect(
    liveEvaluationVerdict([
      { repetition: 1, role: "research", expected, scored: 3 },
      { repetition: 1, role: "synthesis", expected, scored: 3 },
      { repetition: 2, role: "research", expected, scored: 3 },
      { repetition: 2, role: "synthesis", expected, scored: 0 },
    ]),
  ).toMatchObject({ complete: false, missing: ["2:synthesis (3 of 3 unscored)"] });
  // Nothing measured is not a complete run, and neither is a trace that cannot say
  // what it set out to score.
  expect(liveEvaluationVerdict([])).toMatchObject({ complete: false, scored: 0, expected: 0, missing: [] });
  expect(liveEvaluationVerdict([{ repetition: 1, role: "research", expected: 0, scored: 0 }])).toMatchObject({
    complete: false,
    missing: ["1:research (no sample recorded)"],
  });
});

it("sizes the live budget from the corpus it will score", async () => {
  // The default budget must be able to score the acceptance set at all, or every
  // live run would open with an incomplete verdict. The constraint that has to hold
  // is the one `sample()` enforces — the acceptance set is never sampled away and
  // the failover reserve is spent first — so the test drives `sample()` instead of
  // restating a looser arithmetic bound. A 19-20-item corpus passes
  // `acceptance * 2 <= modelCalls` while making `sample()` throw for every
  // evaluation.
  const evaluation = await routineEvaluation(routineStore(), {
    ownerEpoch: "live",
    ready: () => true,
    models: {
      stream: async () => {
        throw new Error("the offline budget test never calls a provider");
      },
    },
  });
  const sample = evaluation.sample();
  expect(sample.acceptance.length).toBeGreaterThan(0);
  expect(sample.acceptance.length * 2).toBeLessThanOrEqual(DEFAULT_EVALUATION_BUDGET.modelCalls);
  expect(DEFAULT_EVALUATION_THRESHOLDS).toEqual({ precision: 0.9, recall: 0.8 });
});

describe.skipIf(process.env["TAVI_LIVE_EVAL"] !== "1")("live evaluation against the operator's provider", () => {
  it(
    "measures both roles and one full routine run, and records the evidence",
    async () => {
      const configured = liveEvalConfigFromEnv(process.env);
      if (!configured.ok) throw new Error(configured.reason);
      const { config } = configured;
      const apiKey = readFileSync(config.apiKeyFile, "utf8").trim();
      if (apiKey === "") throw new Error(`the credential file ${config.apiKeyFile} is empty`);

      mkdirSync(config.traceDirectory, { recursive: true });
      let calls = 0;
      const stamp = nowTimestamp().replace(/[-:.]/g, "").slice(0, 15);
      // Abort on the first provider failure: a repetition that half-completed is
      // recorded as incomplete, never averaged into the others.
      let providerFailure: string | undefined;
      const model: ModelPort = {
        stream: async (request, options) => {
          if (providerFailure !== undefined) throw new Error(providerFailure);
          if (calls >= config.callCeiling) {
            providerFailure = `the ${config.callCeiling}-call ceiling was reached`;
            throw new Error(providerFailure);
          }
          calls += 1;
          const started = Date.now();
          const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: config.model,
              messages: request.messages.map((message) => ({ role: message.role, content: message.text })),
              max_tokens: request.maxOutputTokens ?? 2048,
              temperature: 0,
            }),
            // The evaluation's deadline is enforced through this signal, so a hung
            // provider is cut off mid-request rather than after `perAttemptMs`.
            signal: options.signal,
          });
          if (!response.ok) {
            providerFailure = `provider returned ${response.status}`;
            throw new Error(providerFailure);
          }
          const body = (await response.json()) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
          const text = body.choices?.[0]?.message?.content ?? "";
          return {
            attemptId: request.attemptId,
            status: "completed" as const,
            text,
            toolCalls: [],
            usage: body.usage?.total_tokens === undefined ? {} : { totalTokens: body.usage.total_tokens },
            latencyMs: Date.now() - started,
          } as never;
        },
      };

      const traces: unknown[] = [];
      for (let repetition = 1; repetition <= config.reps; repetition += 1) {
        const store = routineStore();
        const routines = new RoutineService(store, { executionAvailable: true, authorizeTarget: () => true, nextOccurrence: () => null });
        const evaluation = await routineEvaluation(store, { ownerEpoch: `live-${repetition}`, ready: () => true, models: model });
        const scope = { workspaceId: "default", principalId: "operator" };
        const created = routines.create(
          scope,
          (await import("@tavi/contracts")).RoutineCreateSchema.parse({
            ...(await import("@tavi/contracts")).routineDefaults("UTC"),
            operationKey: `live-${repetition}`,
            name: "Live evaluation",
            objective: "Find current LLM model releases",
            agent: { agentId: "live-news", name: "Live news", instructions: "Research current model releases." },
            triggers: [{ id: "daily", kind: "daily", at: "09:00", timezone: "UTC" }],
            skills: [],
            models: {
              research: { primary: { connectionId: "live", model: config.model }, fallbacks: [] },
              synthesis: { primary: { connectionId: "live", model: config.model }, fallbacks: [] },
            },
            permissions: { revision: 1, researchTools: [], allowedHosts: ["example.com"], networkMode: "allowlist" },
          }),
        );
        await evaluation.drain();
        const measured = JSON.parse(
          (
            store.handle.prepare("SELECT data_json FROM tavi_routine_quality ORDER BY updated_at DESC LIMIT 1").get() as {
              data_json: string;
            }
          ).data_json,
        ) as Record<string, unknown>;
        traces.push({ repetition, model: config.model, baseUrl: config.baseUrl, routineId: created.routine.routineId, measured });
      }
      const traceFile = liveEvalTracePath(config, 1, stamp).replace(/rep1\.json$/, `rep1-${config.reps}.json`);
      writeFileSync(
        traceFile,
        JSON.stringify(
          {
            config: { ...config, apiKeyFile: "(redacted)" },
            calls,
            corpusHash: (await import("@tavi/runtime")).routineCorpusHash(corpus),
            traces,
          },
          null,
          1,
        ),
      );
      // The verdict for the run as a whole: every repetition, both roles, measured
      // against the sample each trace actually set out to score. The harness has no
      // per-item identities to match on — the trace records counters — so completion
      // comes from the counts the run produced rather than a re-derived list of
      // expected case names that could never match.
      const measurements = traces.flatMap((trace) => {
        const measured = (
          trace as {
            repetition: number;
            measured: { sample?: { total?: number }; roles?: { research?: { scored?: number }; synthesis?: { scored?: number } } };
          }
        ).measured;
        return (["research", "synthesis"] as const).map((role) => ({
          repetition: (trace as { repetition: number }).repetition,
          role,
          expected: measured.sample?.total ?? 0,
          scored: measured.roles?.[role]?.scored ?? 0,
        }));
      });
      const verdict = liveEvaluationVerdict(measurements);
      expect(verdict.complete, `incomplete: ${verdict.missing.slice(0, 5).join("; ")}`).toBe(true);
      expect(calls).toBeLessThanOrEqual(config.callCeiling);
    },
    60 * 60 * 1000,
  );
});
