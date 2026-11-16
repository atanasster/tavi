import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An inline `style` carries only what the script computes (a dragged width, a
 * measured place, a duration); a fixed size or colour belongs in a stylesheet
 * as a token. This refuses a `style` whose object gives a property a literal
 * string or number.
 */
const root = join(import.meta.dirname, "..", "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

/** Each `style={…}` expression in `source`, and each `style: {…}` object handed on as a prop, by its balanced braces. */
function styleExpressions(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bstyle(?:=\{|:\s*(?=\{))/g)) {
    const start = match.index + match[0].length;
    let depth = match[0].endsWith("{") ? 1 : 0;
    if (depth === 0) {
      // `style: {` — the object itself is the expression, its opening brace included.
      let at = start;
      do {
        const char = source[at];
        if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
        at += 1;
      } while (at < source.length && depth > 0);
      found.push(source.slice(start, at));
      continue;
    }
    let at = start;
    while (at < source.length && depth > 0) {
      const char = source[at];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      at += 1;
    }
    found.push(source.slice(start, at - 1));
  }
  return found;
}

/**
 * A property of an object literal in `expression` whose value is a literal string or number, or whose
 * value ends in one (a conditional's branch, a fallback).
 */
function literalStyle(expression: string): string | undefined {
  const literal = /(?:^|[{,])\s*(?:"[^"]+"|'[^']+'|\[[^\]]+\]|[\w$]+)\s*:\s*(?:-?\.?\d[\d.]*|"[^"]*"|'[^']*'|`[^`$]*`)\s*(?=[,}]|$)/;
  const branch = /(?:\?\?|\|\||[?:])\s*(?:-?\.?\d[\d.]*|"[^"]*"|'[^']*'|`[^`$]*`)\s*(?=[,}]|$)/;
  return (literal.exec(expression) ?? branch.exec(expression))?.[0].trim();
}

describe("inline styles carry only computed values", () => {
  it("refuses a literal and passes what is computed", () => {
    expect(literalStyle("{ width: 12 }")).toBeDefined();
    expect(literalStyle('{ width: "12px" }')).toBeDefined();
    expect(literalStyle("{ height, width: `12px` }")).toBeDefined();
    expect(literalStyle('{ "--x": "1px" } as CSSProperties')).toBeDefined();
    expect(literalStyle("{ height }")).toBeUndefined();
    expect(literalStyle("position")).toBeUndefined();
    expect(literalStyle("{ height: `${height}px` }")).toBeUndefined();
    expect(literalStyle("open ? undefined : { left: `${x}px`, top: y }")).toBeUndefined();
    // A literal branch or fallback, a computed key, and a multi-line object with a spread.
    expect(literalStyle("{ width: open ? 12 : 0 }")).toBeDefined();
    expect(literalStyle("{ width: w ?? 12 }")).toBeDefined();
    expect(literalStyle("{ [k]: 4 }")).toBeDefined();
    expect(literalStyle("{\n  ...base,\n  width: 4,\n}")).toBeDefined();
    expect(literalStyle("{\n  ...base,\n  width: `${w}px`,\n}")).toBeUndefined();
    expect(literalStyle("{ a: b ? c : d }")).toBeUndefined();
  });

  it("sets no literal value in an inline style under src/", () => {
    const sources = files(root).filter((path) => path.endsWith(".tsx"));
    const expressions = sources.flatMap((path) => styleExpressions(readFileSync(path, "utf8")).map((expression) => ({ path, expression })));
    expect(expressions.length).toBeGreaterThan(0);
    const offenders = expressions.filter(({ expression }) => literalStyle(expression) !== undefined);
    expect(offenders).toEqual([]);
  });
});
