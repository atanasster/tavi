import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { checkoutRevision } from "../../src/cli/checkout-revision.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

function checkout(): { root: string; git: string } {
  const root = directories.create("tavi-revision-");
  const git = join(root, ".git");
  mkdirSync(join(git, "refs", "heads"), { recursive: true });
  mkdirSync(join(root, "apps", "cli", "dist"), { recursive: true });
  return { root, git };
}

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("checkoutRevision", () => {
  it("follows HEAD to a branch's loose ref, from anywhere under the checkout", () => {
    const { root, git } = checkout();
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(git, "refs", "heads", "main"), `${A}\n`);
    expect(checkoutRevision(join(root, "apps", "cli", "dist"))).toBe("a".repeat(12));
  });

  it("reads a packed ref, and a detached HEAD", () => {
    const { root, git } = checkout();
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(git, "packed-refs"), `# pack-refs with: peeled\n${B} refs/heads/main\n`);
    expect(checkoutRevision(root)).toBe("b".repeat(12));
    writeFileSync(join(git, "HEAD"), `${A}\n`);
    expect(checkoutRevision(root)).toBe("a".repeat(12));
  });

  it("follows a worktree's .git file to its own HEAD and the common refs", () => {
    const { root, git } = checkout();
    writeFileSync(join(git, "refs", "heads", "feature"), `${B}\n`);
    const worktreeGit = join(git, "worktrees", "wt");
    mkdirSync(worktreeGit, { recursive: true });
    writeFileSync(join(worktreeGit, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(join(worktreeGit, "commondir"), "../..\n");
    const worktree = join(root, "wt");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGit}\n`);
    expect(checkoutRevision(worktree)).toBe("b".repeat(12));
  });

  it("follows a relative gitdir, and is undefined for a ref that does not exist", () => {
    const { root, git } = checkout();
    writeFileSync(join(git, "refs", "heads", "main"), `${A}\n`);
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    const nested = join(root, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".git"), "gitdir: ../.git\n");
    expect(checkoutRevision(nested)).toBe("a".repeat(12));
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/gone\n");
    expect(checkoutRevision(root)).toBeUndefined();
  });

  it("is undefined for an install under node_modules, even inside another repository", () => {
    const { root, git } = checkout();
    writeFileSync(join(git, "HEAD"), `${A}\n`);
    const installed = join(root, "node_modules", "@tavi", "cli", "dist");
    mkdirSync(installed, { recursive: true });
    expect(checkoutRevision(installed)).toBeUndefined();
  });

  it("is undefined outside a checkout", () => {
    const outside = directories.create("tavi-revision-none-");
    expect(checkoutRevision(outside)).toBeUndefined();
  });
});
