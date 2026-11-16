import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectRepositoryPort } from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The project registry.
 *
 * Before this, which projects existed lived in `<dataDir>/projects.json`: a file
 * the agent could not see, that nothing could query, and that a second writer
 * could silently disagree with. The database is now the authority and the file
 * is an import source, which is what these tests pin — including that importing
 * twice is not a way to end up with two of everything.
 */

const directories = temporaryDirectories({ prefix: "tavi-projects-" });

afterEach(() => directories.cleanup());

async function withStore<T>(directory: string, body: (projects: ProjectRepositoryPort) => T | Promise<T>): Promise<T> {
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  try {
    return await body(store.asPort().repositories.projects);
  } finally {
    await store.close();
  }
}

describe("tavi projects", () => {
  it("adds a project and shows which sources it has", async () => {
    const directory = directories.create();
    const added = capture();
    expect(
      await main(
        [
          "projects",
          "add",
          "ai-crucible",
          "--name",
          "AI Crucible",
          "--ga4",
          "properties/513076108",
          "--gsc",
          "sc-domain:ai-crucible.com",
          "--stripe-ref",
          "stripe.key",
          "--keyword",
          "ai-crucible,ai crucible",
          "--language",
          "en",
          "--region",
          "US",
          "--data-dir",
          directory,
        ],
        { io: added.io },
      ),
    ).toBe(EXIT.ok);

    const shown = capture();
    expect(await main(["projects", "show", "ai-crucible", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/project ai-crucible \(AI Crucible\)/);
    expect(shown.stdout()).toMatch(/ga4 {7}properties\/513076108/);
    expect(shown.stdout()).toMatch(/keywords {2}ai-crucible, ai crucible/);
    // GCP is unconfigured here, and says so rather than showing an empty value.
    expect(shown.stdout()).toMatch(/gcp {7}\(not configured\)/);
  });

  it("refuses half of the GCP billing pair, which the registry stores as one object", async () => {
    const directory = directories.create();
    const bad = capture();
    expect(await main(["projects", "add", "p", "--gcp-project", "billing-proj", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/--gcp-project and --gcp-table must be given together/);
  });

  it("refuses a duplicate id rather than silently replacing the accounts", async () => {
    const directory = directories.create();
    await main(["projects", "add", "acme", "--ga4", "properties/1", "--data-dir", directory], { io: capture().io });
    const again = capture();
    // A duplicate id is something the operator can fix, so it exits as a usage
    // error — not as `alreadyOwned`, which means another process holds the data
    // directory and would send them looking for a nonexistent second process.
    expect(await main(["projects", "add", "acme", "--ga4", "properties/2", "--data-dir", directory], { io: again.io })).toBe(EXIT.usage);
    expect(again.stderr()).toMatch(/already exists/);
  });

  it("parks a project with disable, then still lists it", async () => {
    const directory = directories.create();
    await main(["projects", "add", "acme", "--ga4", "properties/1", "--data-dir", directory], { io: capture().io });
    const disabled = capture();
    expect(await main(["projects", "disable", "acme", "--data-dir", directory], { io: disabled.io })).toBe(EXIT.ok);
    expect(disabled.stdout()).toMatch(/acme\t\tdisabled/);
    // Visible to the operator, invisible to the collectors — the point of
    // parking rather than deleting.
    const listed = capture();
    expect(await main(["projects", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain("acme");
    await withStore(directory, async (projects) => {
      expect((await projects.list("default", { enabledOnly: true })).projects).toHaveLength(0);
    });
  });

  it("refuses an unknown project id as usage", async () => {
    const directory = directories.create();
    const missing = capture();
    expect(await main(["projects", "show", "nope", "--data-dir", directory], { io: missing.io })).toBe(EXIT.usage);
    expect(missing.stderr()).toMatch(/no project "nope" exists/);
  });

  it("rejects an edit flag on a lifecycle action instead of ignoring it", async () => {
    const directory = directories.create();
    await main(["projects", "add", "acme", "--data-dir", directory], { io: capture().io });
    const bad = capture();
    expect(await main(["projects", "enable", "acme", "--ga4", "properties/9", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/does not accept --ga4/);
  });

  it("documents its own flags on --help", async () => {
    const shown = capture();
    expect(await main(["projects", "--help"], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/Manage the projects your reports collect data for/);
    expect(shown.stdout()).toMatch(/--keyword <word>/);
    // `add` takes a positional id, exactly like `agents add`; the usage line
    // omitted it, so the error message was the only documentation.
    expect(shown.stdout()).toMatch(/add <id>/);
  });
});

describe("tavi projects import", () => {
  const FILE = {
    googleServiceAccountRef: "google.serviceAccount",
    lookbackDays: 7,
    news: { feedUrls: ["https://news.example/rss"], maxItemsPerProject: 3 },
    projects: [
      { id: "acme", name: "Acme", ga4PropertyId: "properties/1", gscSiteUrl: "sc-domain:acme.example", keywords: ["acme"] },
      { id: "globex", name: "Globex", ga4PropertyId: "properties/2" },
    ],
  };

  it("reads projects.json once, including the deployment-wide settings", async () => {
    const directory = directories.create();
    writeFileSync(join(directory, "projects.json"), JSON.stringify(FILE), { mode: 0o600 });
    const imported = capture();
    expect(await main(["projects", "import", "--format", "json", "--data-dir", directory], { io: imported.io })).toBe(EXIT.ok);
    expect(JSON.parse(imported.stdout())).toMatchObject({ imported: 2, skipped: [] });

    await withStore(directory, async (projects) => {
      expect((await projects.list("default")).projects.map((project) => project.id)).toEqual(["acme", "globex"]);
      // The settings the file carried are now durable registry state, not a
      // second half of the configuration still living in the file.
      expect(await projects.getSettings("default")).toMatchObject({
        googleServiceAccountRef: "google.serviceAccount",
        lookbackDays: 7,
      });
      expect((await projects.getSettings("default")).news?.feedUrls).toEqual(["https://news.example/rss"]);
    });
  });

  it("does not clear settings a later, partial import file omits", async () => {
    const directory = directories.create();
    writeFileSync(join(directory, "projects.json"), JSON.stringify(FILE), { mode: 0o600 });
    await main(["projects", "import", "--data-dir", directory], { io: capture().io });
    // An operator adds a second project and sets a lookback window in the
    // registry, then re-imports an older file that mentions neither.
    await main(["projects", "add", "extra", "--data-dir", directory], { io: capture().io });
    await withStore(directory, async (projects) => {
      // `putSettings` replaces the whole row (it takes a full `CollectorSettings`),
      // so a caller setting one field sends the others it wants kept — which is
      // exactly why `import` merges explicitly rather than calling this blind.
      await projects.putSettings({
        workspaceId: "default",
        settings: { googleServiceAccountRef: "google.serviceAccount", lookbackDays: 30 },
        now: "2026-04-05T00:00:00.000Z",
      });
    });
    writeFileSync(join(directory, "projects.json"), JSON.stringify({ projects: FILE.projects }), { mode: 0o600 });
    const again = capture();
    expect(await main(["projects", "import", "--data-dir", directory], { io: again.io })).toBe(EXIT.ok);

    await withStore(directory, async (projects) => {
      const settings = await projects.getSettings("default");
      // The file said nothing about either, so neither may be cleared — a
      // re-import that reported success must not break the next brief.
      expect((await settings).googleServiceAccountRef).toBe("google.serviceAccount");
      expect((await settings).lookbackDays).toBe(30);
      expect((await projects.list("default")).projects).toHaveLength(3);
    });
  });

  it("is idempotent: importing twice leaves the existing projects alone", async () => {
    const directory = directories.create();
    writeFileSync(join(directory, "projects.json"), JSON.stringify(FILE), { mode: 0o600 });
    await main(["projects", "import", "--data-dir", directory], { io: capture().io });
    const again = capture();
    expect(await main(["projects", "import", "--format", "json", "--data-dir", directory], { io: again.io })).toBe(EXIT.ok);
    // Re-importing must not be a way to end up with two of everything, and must
    // not overwrite a project an operator has since edited in the registry.
    expect(JSON.parse(again.stdout())).toMatchObject({ imported: 0, skipped: ["acme", "globex"] });
    await withStore(directory, async (projects) => {
      expect((await projects.list("default")).projects).toHaveLength(2);
    });
  });

  it("refuses a file that lists the same id twice before writing anything at all", async () => {
    // The whole file is judged before the first write, so a file the
    // command refuses cannot leave the settings row written and half the
    // projects created while reporting failure.
    const directory = directories.create();
    writeFileSync(
      join(directory, "projects.json"),
      JSON.stringify({
        googleServiceAccountRef: "google.serviceAccount",
        lookbackDays: 14,
        projects: [
          { id: "acme", name: "Acme", ga4PropertyId: "properties/1" },
          { id: "acme", name: "Acme again", ga4PropertyId: "properties/2" },
        ],
      }),
      { mode: 0o600 },
    );
    const refused = capture();
    expect(await main(["projects", "import", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/lists project "acme" more than once; nothing was imported/);
    await withStore(directory, async (projects) => {
      expect((await projects.list("default")).projects).toHaveLength(0);
      // The settings would have been written first under the old ordering.
      expect((await projects.getSettings("default")).lookbackDays).toBeUndefined();
    });
  });

  it("rolls back the settings and every earlier project when a later create path fails", async () => {
    // Pins the transaction rather than just the pre-flight: with the `Set` check
    // in place but `store.transaction` removed, this test fails and the previous
    // one still passes. The failure is a registry row only a hand edit or a
    // restored backup could produce, whose id the import file also names —
    // `projects.get` validates the row on the way out and throws, unlike `list`,
    // which isolates it into `unreadable`.
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      store.handle
        .prepare(
          `INSERT INTO tavi_projects (workspace_id, project_id, name, keywords_json, enabled, created_at, updated_at)
           VALUES ('default', 'broken-row', 'Broken', '{oops', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
    } finally {
      await store.close();
    }
    writeFileSync(
      join(directory, "projects.json"),
      JSON.stringify({
        googleServiceAccountRef: "google.serviceAccount",
        lookbackDays: 14,
        // `aaa` succeeds first; `broken-row` then throws. Neither may survive.
        projects: [
          { id: "aaa", name: "Aaa", ga4PropertyId: "properties/1" },
          { id: "broken-row", name: "Broken" },
        ],
      }),
      { mode: 0o600 },
    );

    const failed = capture();
    expect(await main(["projects", "import", "--data-dir", directory], { io: failed.io })).toBe(EXIT.internal);

    await withStore(directory, async (projects) => {
      // The project created before the failure is rolled back with it…
      expect((await projects.list("default")).projects).toHaveLength(0);
      expect((await projects.list("default")).unreadable).toEqual(["broken-row"]);
      // …and so is the settings row written first. Without the transaction both
      // survive the failure and the command reports failure over a partial
      // commit.
      expect(await projects.getSettings("default")).toEqual({});
    });
  });

  it("fails clearly when there is no file to import", async () => {
    const directory = directories.create();
    const missing = capture();
    // A missing file is the operator's to fix, not an internal failure.
    expect(await main(["projects", "import", "--data-dir", directory], { io: missing.io })).toBe(EXIT.usage);
    expect(missing.stderr()).toMatch(/no projects file exists to import/);
  });
});

describe("the agent's view of the registry", () => {
  it("reports which sources each project has, and never a credential value", async () => {
    const directory = directories.create();
    await main(
      ["projects", "add", "acme", "--ga4", "properties/1", "--stripe-ref", "acme.stripe.key", "--keyword", "acme", "--data-dir", directory],
      { io: capture().io },
    );
    await withStore(directory, async (projects) => {
      await projects.putSettings({
        workspaceId: "default",
        settings: { googleServiceAccountRef: "google.serviceAccount" },
        now: "2026-04-05T00:00:00.000Z",
      });
    });
    const { composeTaviRuntime } = await import("../../src/runtime/composition.js");
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), {
      requireModelTransport: false,
    });
    try {
      const tool = runtime.tools.get("projects.get");
      if (tool === undefined) throw new Error("projects.get is not registered");
      const result = (await tool.handler({
        input: {},
        context: { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "cli" },
        signal: new AbortController().signal,
      })) as { readonly projects: readonly { readonly id: string; readonly sources: Record<string, boolean> }[] };
      expect(result.projects[0]?.id).toBe("acme");
      expect(result.projects[0]?.sources).toMatchObject({ ga4: true, gsc: false, stripe: true, news: true });
      // The fixture writes a settings row precisely so this assertion is not
      // vacuous: the first version never did, so the field was always `null` and
      // the leak of the reference name went unnoticed.
      const serialized = JSON.stringify(result);
      expect((result as { readonly googleConfigured?: boolean }).googleConfigured).toBe(true);
      expect(serialized).not.toContain("google.serviceAccount");
      // Deliberately narrower than the registry itself: the agent learns
      // *whether* a source is configured, which is what asking only for the
      // gaps needs. Neither a credential value nor the operator's reference
      // naming scheme is exposed to a model.
      expect(serialized).not.toContain("acme.stripe.key");
      expect(serialized).not.toMatch(/sk_|BEGIN PRIVATE KEY/);
    } finally {
      await runtime.close();
    }
  });

  it("answers an unknown project id with NOT_FOUND rather than an empty list", async () => {
    const directory = directories.create();
    await main(["projects", "add", "acme", "--data-dir", directory], { io: capture().io });
    const { composeTaviRuntime } = await import("../../src/runtime/composition.js");
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), {
      requireModelTransport: false,
    });
    try {
      const tool = runtime.tools.get("projects.get");
      if (tool === undefined) throw new Error("projects.get is not registered");
      await expect(
        tool.handler({
          input: { projectId: "ghost" },
          context: { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "cli" },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/No project ghost is configured/);
    } finally {
      await runtime.close();
    }
  });

  it("lists the readable projects and names the row it could not read, on stderr", async () => {
    const directory = directories.create();
    writeFileSync(
      join(directory, "projects.json"),
      JSON.stringify({ projects: [{ id: "acme", name: "Acme", ga4PropertyId: "properties/1" }] }),
      { mode: 0o600 },
    );
    const imported = capture();
    expect(await main(["projects", "import", "--format", "json", "--data-dir", directory], { io: imported.io })).toBe(EXIT.ok);
    // A row only a hand edit or a restored backup could produce.
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      store.handle
        .prepare(
          `INSERT INTO tavi_projects (workspace_id, project_id, name, keywords_json, enabled, created_at, updated_at)
           VALUES ('default', 'broken-row', 'Broken', '{oops', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
    } finally {
      await store.close();
    }

    const listed = capture();
    expect(await main(["projects", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    // The healthy projects are still listed: one bad row must not hide the
    // registry, and it must not vanish from the output either.
    expect(listed.stdout()).toContain("acme");
    expect(listed.stderr()).toContain("broken-row");
    expect(listed.stderr()).toContain("could not be read");
  });
});
