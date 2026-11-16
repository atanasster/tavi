import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { scrubCredentialText } from "@tavi/contracts";

import { SqliteStore } from "../src/persistence/store.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

describe("routine prerequisite boundary probes", () => {
  it("documents why generic scrubbing cannot be the capture boundary", () => {
    const raw = {
      headers: { cookie: "session=fixture-private" },
      url: "https://fixture.invalid/?q=fixture-private",
      error: "apiKey: fixture-private",
    };
    const scrubbed = scrubCredentialText(JSON.stringify(raw));
    // Arbitrary cookie/query values lack a recognizable credential shape.
    // Future capture must project approved fields, not serialize this object.
    expect(scrubbed).toContain("session=fixture-private");
    expect(scrubbed).toContain("?q=fixture-private");
    expect(scrubCredentialText(raw.error)).not.toContain("fixture-private");
  });

  it("documents the filesystem orphan when artifact metadata insertion fails", () => {
    const directory = directories.create("tavi-routine-probe-");
    const artifactsDirectory = join(directory, "artifacts");
    const store = new SqliteStore({ databasePath: join(directory, "db.sqlite"), artifactsDirectory });
    try {
      store.handle.exec(
        "CREATE TRIGGER probe_fail BEFORE INSERT ON tavi_artifacts BEGIN SELECT RAISE(ABORT, 'fixture metadata failure'); END",
      );
      expect(() => store.putArtifact({ workspaceId: "default", contentType: "text/plain", body: "fixture report" })).toThrow(
        "fixture metadata failure",
      );
      expect(store.handle.prepare("SELECT count(*) AS n FROM tavi_artifacts").get()).toEqual({ n: 0 });
      expect(readdirSync(join(artifactsDirectory, "default"))).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
