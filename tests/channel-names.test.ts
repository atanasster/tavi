import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { TEST_SUPPORT, workspacePackageDirectories } from "./support/dependency-rules.js";

/**
 * Core never names a channel
 * provider. A channel is known by its descriptor and connector; the code that
 * names one lives in its own plugin package (`packages/builtin/*`, `packages/external/*`). This scans every
 * non-test source file outside those packages for the names of the channels
 * this repository ships or plans (comments aside) and holds each file to the
 * count it has today.
 *
 * The allowlist only shrinks: a file not on it may name no channel, a file on
 * it may not name one more often, and a file that names fewer than its
 * ceiling must have its ceiling lowered (so progress is kept). It is now down
 * to one file:
 * - `apps/cli/src/features/plugins/catalog.ts` — the builtin plugins and channels, by name;
 * One more names messengers without being channel code: the jobs kit's scam
 * flags (`packages/jobs-kit/src/flags.ts`), where a fake recruiter moving an
 * interview to WhatsApp or Telegram is the signal; and the MCP review's
 * overlap words (`apps/cli/src/features/mcp/review.ts`), where a server named
 * for Gmail or Telegram may do the job of Tavi's own mail or messaging tools.
 * Setup names Telegram as its terminal
 * channel step and in the import of another agent's Telegram bot. The
 * language catalogues (`src/locales/`) are words a person reads, not code, and
 * are not scanned.
 * (The release test's package list is a test, so it is not scanned.)
 */

const root = join(import.meta.dirname, "..");
const NAMES = /telegram|mailgun|gmail|whatsapp|discord/gi;

/** Each file allowed to name a channel, with the most times it may. */
const ALLOWED: Readonly<Record<string, number>> = {
  // The catalog: each built-in channel's plugin by id, and its package.
  "apps/cli/src/features/plugins/catalog.ts": 18,
  // Not a channel: the Ideas capabilities stored before they became categories (`telegram`, `discord`, `gmail`),
  // read as the category they are now.
  "packages/runtime/src/persistence/ideas-repository.ts": 3,
  // Not a channel: messengers a fake recruiter moves an interview to, read as a scam signal.
  "packages/jobs-kit/src/flags.ts": 5,
  // Not a channel: the words in a third-party MCP server's name or tools that say it wraps a mail or messaging
  // service, read as an overlap with Tavi's own mail and messaging tools (the approval's shadowing warning).
  "apps/cli/src/features/mcp/review.ts": 4,
  // Not a channel: the public mailbox domains an email trigger refuses as an `@domain` sender, where anyone can get
  // an address.
  "apps/cli/src/features/schedules/email-trigger.ts": 1,
  // Not a channel: the kind and pattern of a Telegram bot token, a credential shape the redaction masks wherever
  // it appears (a pasted token, a tool's output), whether or not the Telegram channel is installed.
  "packages/contracts/src/redaction.ts": 2,
  // Not a channel: the plugins onboarding's conformance suite expects this build to ship, by id.
  "packages/plugin-kit/src/onboarding/conformance.ts": 5,
  // Setup features one channel by default (its descriptor words the step), and points at one app:
  // `--channel-secret telegram:token=…` in its usage, `tavi apps connect gmail` as a step's command; the import
  // reads OpenClaw's and Hermes's own Telegram settings by their documented keys; and "New with Gmail" maps the
  // app to its Ideas capability.
  "apps/cli/src/features/onboard/parse.ts": 3,
  "apps/cli/src/features/onboard/client.ts": 2,
  "apps/cli/src/features/onboard/steps.ts": 1,
  "apps/cli/src/features/onboard/import.ts": 38,
  "apps/ui/src/features/welcome/IdeasStep.tsx": 1,
  // Not a channel: the Google Cloud console steps for a sign-in client, whose link names the Gmail API to enable
  // by its id (the steps' words are in the catalogue).
  "apps/cli/src/features/apps/client-setup.ts": 1,
  // Not a channel: the example app id in the `apps` tool's own description.
  "apps/cli/src/features/apps/tool.ts": 1,
};

/**
 * Source with its comments removed: a name in a comment is documentation, not
 * code. One pass, left to right, that steps over string, template and regex
 * literals whole, so a `/*` inside a line comment, a `//` inside a string (a
 * URL) or a quote inside a regex is read as what it is.
 */
function code(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    let end: number;
    if (char === "/" && next === "/") {
      end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") end = literalEnd(source, index, char);
    else if (char === "/" && REGEX_CONTEXT.test(out.slice(-12))) end = regexEnd(source, index);
    else end = index;
    out += source.slice(index, end + 1);
    index = end + 1;
  }
  return out;
}

/** What may come right before a regex literal: an operator, an opening bracket, `return` or `typeof`; anything else makes `/` a division. */
const REGEX_CONTEXT = /(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/;

/** The index of the quote closing the literal opened at `start`, past escapes. */
function literalEnd(source: string, start: number, quote: string): number {
  let end = start + 1;
  while (end < source.length && source[end] !== quote) end += source[end] === "\\" ? 2 : 1;
  return end;
}

/** The index of the `/` closing the regex opened at `start`, past escapes and character classes. */
function regexEnd(source: string, start: number): number {
  let end = start + 1;
  let inClass = false;
  while (end < source.length && source[end] !== "\n" && (source[end] !== "/" || inClass)) {
    if (source[end] === "\\") end += 1;
    else if (source[end] === "[") inClass = true;
    else if (source[end] === "]") inClass = false;
    end += 1;
  }
  return end;
}

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (["node_modules", "dist", "test", "tests"].includes(name)) continue;
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

function channelNamesInCore(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pkg of workspacePackageDirectories(root)) {
    // A channel's own package is where its name belongs.
    if (pkg.startsWith("packages/builtin/") || pkg.startsWith("packages/external/")) continue;
    // Test support is test code, as a package's own `test/` is: its fake Discord names Discord.
    if (TEST_SUPPORT.includes(pkg)) continue;
    const src = join(root, pkg, "src");
    if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of sources(src)) {
      // A language catalogue's words name channels as a person reads them (the built-ins' setup words, a reply
      // "sent to Telegram"): words, not channel code. A catalogue never decides by a channel's name.
      if (file.split(sep).includes("locales")) continue;
      const count = code(readFileSync(file, "utf8")).match(NAMES)?.length ?? 0;
      if (count > 0) counts[relative(root, file).split(sep).join("/")] = count;
    }
  }
  return counts;
}

describe("channel names in core", () => {
  it("are only where the allowlist says, never more often, and each ceiling is kept tight", () => {
    const found = channelNamesInCore();
    for (const [file, count] of Object.entries(found)) {
      expect(ALLOWED[file], `${file} names a channel provider ${count} time(s); move it behind the channel's descriptor`).toBeDefined();
      expect(count, `${file} names a channel provider more often than its allowance`).toBeLessThanOrEqual(ALLOWED[file] ?? 0);
    }
    for (const [file, ceiling] of Object.entries(ALLOWED)) {
      expect(
        found[file] ?? 0,
        `${file} now names a channel provider fewer times: lower its allowance to ${found[file] ?? 0}${found[file] === undefined ? " (remove it)" : ""}`,
      ).toBe(ceiling);
    }
  });
});
