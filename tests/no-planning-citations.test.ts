import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * No tracked source, test or document cites the planning record: a decision id
 * (`D-123`), a plan file, a plan section (`§4.2`), a step id (`MEM2.1`, `SB-3`,
 * `VD-10`, `RC-02`, ...), a plan's question or phase (`plan Q7`, `phase 2`,
 * `completion plan C2`), a task or finding id (`T1.3`, `step 2.4`, `plan P10`, `(S3, S4)`), a plan's
 * requirement id (`(R4)`, `R12's`), or the notes the plans were written from. Ids the code itself
 * defines are not citations: the heartbeat's gates (`G2's busy half`) and the injection eval's gaps
 * (`GAPS` in `evals/injection/schema.ts`, `(G14)`), for instance, are named where they are used. A reader of the code
 * cannot follow one, so the code says what it means instead.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CITATION =
  /\bD-\d{3}\b|-PLAN\.md|\b(?:MEM|SB|MCP|CA|OPS|DC|TR|PD|VD|UC|MD)-?\d+(?:\.\d+)?\b|DECISIONS\.md|research_notes|§\s?\d|\bRC-\d+\b|\b[Pp]lan (?:[Pp]hase |Q)\d|\b[Cc]ompletion plan\b|\b[Pp]hase \d+\b|\bT[0-4]\.\d{1,2}\b|\b[Ss]tep \d+\.\d+\b|\b[Pp]lan [PTS]\d|security[- ](?:and[- ])?performance plan|\([PS]\d{1,2}[a-z]?(?:,\s?[PST]\d{1,2}(?:\.\d{1,2})?[a-z]?)*\)|\(R\d{1,2}[a-z]?\)|\bR\d{1,2}'s\b/;

/**
 * Text that looks like a citation and is not one, cut from a line before it is
 * checked. Each entry says why it stays.
 */
const ALLOWED: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    pattern: /\b(?:RFC \d+|ISO \d+(?:-\d+)?|OIDC Core)[^§]{0,3}§\s?[\d.–-]+/g,
    reason:
      "A section of a published standard (`RFC 9728 §5.1`, `ISO 32000-1 §7.6.3.2`, `OIDC Core §3.1.3.7`), which a reader can look up.",
  },
  {
    pattern: /\b(?:terms|Terms|User Agreement)\b[^§]{0,3}(?:§[\w.()]+(?:, )?)+/g,
    reason:
      "A clause of a site's terms of service (`terms §8.4.3`, `User Agreement §8.2`), quoted as the reason a site profile refuses it.",
  },
];

/** Files the check does not read, each with its reason. */
const SKIPPED: readonly { readonly test: (path: string) => boolean; readonly reason: string }[] = [
  { test: (path) => path === "CHANGELOG.md", reason: "The history, which records past work by name." },
  // The plans are the planning record this check keeps out of code; a plan citing a plan (a research note links its plan) is the point.
  {
    test: (path) => path.startsWith("plans/"),
    reason: "The planning record itself: implementation plans and their research notes, which cite one another.",
  },
  { test: (path) => path === "tests/no-planning-citations.test.ts", reason: "This check spells out what it looks for." },
  { test: (path) => /(^|\/)(fixtures?|fixture-site)\//.test(path), reason: "Fixtures are recorded or synthetic input, not prose." },
  { test: (path) => /(^|\/)(node_modules|dist|dist-plugin|ui-dist)\//.test(path), reason: "Installed and built output." },
  { test: (path) => path === "pnpm-lock.yaml", reason: "Generated." },
];

const TEXT = /\.(?:[cm]?[jt]s|tsx|css|html|json|jsonc|md|ya?ml|sh|toml|txt)$/;

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((path) => TEXT.test(path) && !SKIPPED.some((skip) => skip.test(path)) && existsSync(join(root, path)));
}

it("cites no planning record in a tracked source, test or document", () => {
  const files = trackedFiles();
  // An empty listing (git missing, a filter gone wrong) would pass silently.
  expect(files.length).toBeGreaterThan(1000);
  const offenders: string[] = [];
  for (const path of files) {
    readFileSync(join(root, path), "utf8")
      .split("\n")
      .forEach((line, index) => {
        const rest = ALLOWED.reduce((text, allowed) => text.replace(allowed.pattern, ""), line);
        if (CITATION.test(rest)) offenders.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
      });
  }
  expect(offenders).toEqual([]);
});

it("allows what each exception names, and no more", () => {
  const cited = (line: string) => CITATION.test(ALLOWED.reduce((text, allowed) => text.replace(allowed.pattern, ""), line));
  expect(cited("protected-resource metadata (RFC 9728 §5.1)")).toBe(false);
  expect(cited("Bit 6 (ISO 32000-1 §7.6.3.2).")).toBe(false);
  expect(cited("Douyin's terms (§2.4, §5.1) bar automated tools")).toBe(false);
  expect(cited("a status pane (step 2.4)")).toBe(true);
  expect(cited("as the plan says (§4.2)")).toBe(true);
  expect(cited("recorded in D-364")).toBe(true);
  expect(cited("see docs/DECISIONS.md")).toBe(true);
  expect(cited("the MEM2.1 step")).toBe(true);
  expect(cited("VD-10")).toBe(true);
  expect(cited("PLANTED-163 is a marker")).toBe(false);
  expect(cited("the web canvas (plan Q7)")).toBe(true);
  expect(cited("left from phase 2")).toBe(true);
  expect(cited("router plugin plan, phase 1")).toBe(true);
  expect(cited("(completion plan C2 / RC-02)")).toBe(true);
  expect(cited("a two-phase commit")).toBe(false);
  expect(cited("RC4-128 encryption, version 1.0.0-RC1")).toBe(false);
  expect(cited("as T1.3's memos are")).toBe(true);
  expect(cited("the index migration (plan P10, P26)")).toBe(true);
  expect(cited("The probe (security and performance plan T0.2)")).toBe(true);
  expect(cited("(security-performance plan T4.6)")).toBe(true);
  expect(cited("held stranger messages (S11)")).toBe(true);
  expect(cited("still reads it (S3, S4)")).toBe(true);
  expect(cited("a repaint (P13).")).toBe(true);
  expect(cited("without PKCE (S256)")).toBe(false);
  expect(cited("Signed and DocMDP P2/P3 forms")).toBe(false);
  expect(cited("HTTP/1.1 and TLS 1.3")).toBe(false);
  // A plan's requirement id, in parentheses or the possessive, as a help line once said it.
  expect(cited("with the change between adjacent periods (R12's CLI half)")).toBe(true);
  expect(cited("held to what the plan (R4) sets")).toBe(true);
  expect(cited("an object in an R2 bucket")).toBe(false);
  // Ids the code defines where it uses them.
  expect(cited("G2's busy half: the person is in Home")).toBe(false);
  expect(cited("a mod's context in an app turn (G14)")).toBe(false);
});
