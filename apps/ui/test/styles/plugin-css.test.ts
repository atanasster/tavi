import { join } from "node:path";

import stylelint from "stylelint";
import { expect, it } from "vitest";

/**
 * The UI plugins' stylesheets keep the canvas's literal rules: `lint:css`
 * covers `src/styles`, and this runs the same `.stylelintrc.yaml` over the
 * built-in browser view's and the example plugin's pages (their
 * `plugin-base.css` is the token block, exempt as `tokens.css` is).
 */
const app = join(import.meta.dirname, "..", "..");
const repo = join(app, "..", "..");

it("lints the UI plugins' stylesheets with the canvas's rules", async () => {
  const { results } = await stylelint.lint({
    files: ["packages/builtin/browser-view/ui/*.css", "examples/ui-plugins/**/*.css"],
    cwd: repo,
    configFile: join(app, ".stylelintrc.yaml"),
  });
  expect(results.length).toBeGreaterThanOrEqual(4);
  const problems = results.flatMap((result) =>
    result.warnings.map((warning) => `${result.source?.slice(repo.length + 1)}:${warning.line} ${warning.text}`),
  );
  expect(problems).toEqual([]);
});
