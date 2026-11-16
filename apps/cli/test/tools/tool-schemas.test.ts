import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Every tool an owner offers a model, as a provider receives it: an object at
 * the root of its parameters. OpenAI refuses a function whose schema is not
 * one ("schema must be a JSON Schema of 'type: "object"'"), which failed every
 * run offered `messaging.send_to` — a discriminated union — until the
 * registry sent a union of objects as one object.
 */

const runtimes: TaviRuntime[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

describe("the tools an owner offers a model", () => {
  it("each has an object at its schema's root", async () => {
    const directory = directories.create("tavi-tool-schemas-");
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory), { modelOverride: createFixtureModel({ turns: [] }) });
    runtimes.push(runtime);
    const tools = runtime.tools.list();
    expect(tools.map((tool) => tool.id)).toContain("messaging.send_to");
    for (const tool of tools) {
      expect(runtime.tools.inputJsonSchemaOf(tool.id), tool.id).toMatchObject({ type: "object" });
    }
    // The union, sent as one object: its forms said in words, a form's own fields optional.
    const sendTo = runtime.tools.inputJsonSchemaOf("messaging.send_to") as {
      properties: Record<string, { enum?: unknown[] }>;
      required: string[];
      description: string;
    };
    expect(sendTo.properties["kind"]?.enum).toEqual(["text", "file"]);
    // `to`, `chatId` (its older name) or `person`: one of them, which the handler checks; `person` may leave out the connection.
    expect(sendTo.required).toEqual(expect.arrayContaining(["kind"]));
    expect(sendTo.properties["person"]).toBeDefined();
    expect(sendTo.required).not.toContain("to");
    expect(sendTo.required).not.toContain("content");
    expect(sendTo.description).toContain('kind "text" requires content');
    // A document by an approved artifact or a folder file: exactly one, said in words.
    expect(sendTo.description).toContain("A document is given by exactly one of artifactId and path");
  });

  it("each example a description gives is a call the tool's own schema accepts", async () => {
    const directory = directories.create("tavi-tool-examples-");
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory), { modelOverride: createFixtureModel({ turns: [] }) });
    runtimes.push(runtime);
    const examples = runtime.tools.list().flatMap((tool) =>
      // `Example: {…}.` or `Examples: {…}; {…}.`, at the description's end: compact JSON, one call each.
      (/ Examples?: (\{.*\})\.$/.exec(tool.description)?.[1]?.split(/(?<=\}); (?=\{)/) ?? []).map((call) => ({ id: tool.id, call })),
    );
    expect(examples.map((example) => example.id)).toEqual(
      expect.arrayContaining(["browser.act", "http.request", "reminders.create", "routines.create", "routines.update"]),
    );
    for (const { id, call } of examples) {
      expect(runtime.tools.inputSchemaOf(id)?.safeParse(JSON.parse(call)).error, `${id}: ${call}`).toBeUndefined();
    }
  });
});
