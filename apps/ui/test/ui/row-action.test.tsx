import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RowAction } from "../../src/ui/RowAction.js";

/** A row's action is drawn by what it is, the same on every list. */
describe("RowAction", () => {
  it("draws an ordinary action as small words, a destructive one outlined in red, an awaited one filled", () => {
    expect(renderToStaticMarkup(<RowAction>Test</RowAction>)).toBe('<button type="button" class="button-sm ghost">Test</button>');
    expect(renderToStaticMarkup(<RowAction tone="danger">Remove</RowAction>)).toBe(
      '<button type="button" class="button-sm danger">Remove</button>',
    );
    expect(renderToStaticMarkup(<RowAction tone="awaited">Approve 1.0.0</RowAction>)).toBe(
      '<button type="button" class="button-sm button-primary">Approve 1.0.0</button>',
    );
  });
});
