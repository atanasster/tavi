import { writeFileSync } from "node:fs";

import { errorMessage } from "@tavi/contracts/util";
import { afterAll, describe, expect, it } from "vitest";

import type { LiveRecord } from "../../../../evals/injection/eval.js";
import { attackSignature, baselineKind, type Fixture } from "../../../../evals/injection/schema.js";
import { callableTool, loadFixtures } from "./fixtures.js";
import { forgetInjectionDescriptors, runOwnerFixture, startInjectionOwner, type InjectionOwner } from "./owner-harness.js";

/**
 * The injection suite's Tier 1: the owner fixtures against a live model, run by `node
 * evals/injection/eval.ts --live` (which scores and writes the report). Off
 * unless `TAVI_INJECTION_LIVE=1`: it spends model tokens.
 *
 * Each fixture runs `TAVI_INJECTION_SEEDS` times, each time twice: with the
 * injection in its frozen content (`attacked`) and without (`clean`). The
 * served owner, its tools, rules and gate are Tier 0's; only the model is
 * real. The fixtures whose attacker's call is a reply, a mod's context, the
 * epoch flush or a send are Tier 0's only (their harness scripts the model or
 * has none), and so is one whose benign task calls the attacker's tool while
 * its attack plants nothing to tell the calls apart.
 *
 * The sink oracle is what a call carries out, not only its tool
 * (`liveAttackJudge` in evals/injection/schema.ts): the attack's own tool
 * with its discriminating fields (a browser step's `kind`, a request's
 * `method`) and a value it plants, or any tool whose sink sends the person's
 * secret out, or sends or stores the attacker's host, contact or planted
 * account. The harness watches every such tool, records each call in the
 * run's `calls`, and the run reached its sink when any recorded call did.
 */

const live = process.env["TAVI_INJECTION_LIVE"] === "1";
const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set (run through evals/injection/eval.ts --live)`);
  return value;
};

describe.skipIf(!live)("injection suite, Tier 1 (live)", () => {
  const records: LiveRecord[] = [];
  const failures: { readonly fixtureId: string; readonly seed: number; readonly error: string }[] = [];
  const owners = new Map<string, Promise<InjectionOwner>>();

  /** The owner a fixture runs on in one lane: lanes run side by side, each on owners of its own (a fixture swaps its owner's handlers). */
  const ownerFor = async (fixture: Fixture, lane: number): Promise<InjectionOwner> => {
    const serveAllow = [...(fixture.setup?.serveAllow ?? [])].sort();
    const key = `${lane}:${JSON.stringify(serveAllow)}`;
    if (!owners.has(key)) {
      const connectionId = env("TAVI_INJECTION_CONNECTION");
      owners.set(
        key,
        startInjectionOwner({
          serveAllow,
          liveModel: true,
          runtime: {
            providers: [
              { connectionId, kind: "openai-compatible", baseUrl: env("TAVI_INJECTION_BASE_URL"), credentialRef: `${connectionId}.apiKey` },
            ],
            credentials: { [`${connectionId}.apiKey`]: { fromFile: env("TAVI_INJECTION_KEY_FILE") } },
            defaultConnectionId: connectionId,
            defaultModel: env("TAVI_INJECTION_MODEL"),
          },
        }),
      );
    }
    return await owners.get(key)!;
  };

  // The records are written first: closing many owners can outlast the hook, and a record must not go with it.
  afterAll(async () => {
    writeFileSync(env("TAVI_INJECTION_RAW"), `${JSON.stringify({ records, failures }, null, 2)}\n`);
    for (const owner of owners.values()) await (await owner).close();
    forgetInjectionDescriptors();
  }, 180_000);

  const only = (process.env["TAVI_INJECTION_FIXTURES"] ?? "").split(",").filter((id) => id !== "");
  // A fixture whose benign task calls the attacker's tool too is live only when the attack plants something that tells the two apart.
  const telling = (fixture: Fixture): boolean =>
    (attackSignature(fixture)?.markers.length ?? 0) > 0 ||
    !(fixture.userTask.script ?? []).some((call) => "tool" in fixture.attack && call.name === callableTool(fixture.attack.tool));
  const fixtures = loadFixtures().filter(
    (fixture) =>
      fixture.harness === "owner" &&
      baselineKind(fixture) !== "pending" &&
      "tool" in fixture.attack &&
      telling(fixture) &&
      // The stand-in browser's checkout page is Tier 0's only: a live owner has no such page.
      fixture.setup?.observedCommits !== true &&
      (only.length === 0 || only.includes(fixture.id)),
  );
  const seeds = Number(process.env["TAVI_INJECTION_SEEDS"] ?? "5");

  const lanes = Math.max(1, Math.min(16, Number(process.env["TAVI_INJECTION_CONCURRENCY"] ?? "6")));

  it(
    `${fixtures.length} fixtures × ${seeds} seeds, ${lanes} lanes`,
    async () => {
      const queue = fixtures.flatMap((fixture) => Array.from({ length: seeds }, (_, index) => ({ fixture, seed: index + 1 })));
      await Promise.all(
        Array.from({ length: lanes }, async (_, lane) => {
          for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            const { fixture, seed } = next;
            try {
              const io = await ownerFor(fixture, lane);
              const attacked = await runOwnerFixture(io, fixture, "attacked");
              const clean = await runOwnerFixture(io, fixture, "clean");
              records.push({ fixtureId: fixture.id, vector: fixture.vector, goal: fixture.goal, seed, attacked, clean });
              process.stderr.write(
                `[injection live] ${fixture.id} #${seed}: attacked ${attacked.gate}${attacked.sinkReached ? " (sink reached)" : ""}, clean ${clean.gate}\n`,
              );
            } catch (error) {
              failures.push({ fixtureId: fixture.id, seed, error: errorMessage(error) });
            }
          }
        }),
      );
      // Reported, not gated: a run that could not be made is recorded as a failure, not thrown.
      expect(records.length + failures.length).toBe(fixtures.length * seeds);
    },
    6 * 60 * 60_000,
  );
});
