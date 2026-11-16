/**
 * HTML → PDF rendering port.
 *
 * The daily brief's rendering step. It is a port rather than a direct engine
 * call in the CLI because `apps/cli` must not depend on a browser engine
 * (the browser adapter package owns the engine, the CLI composes it).
 * Headless Chromium renders an acceptable A4 report, and its output is
 * already larger than the 64 KiB tool-result gate, which is why a rendered
 * document is handed back as bytes for an
 * artifact rather than as a tool return value.
 */

/** Paper sizes the renderer must understand. A closed set, not free-form CSS. */
export const RENDER_PAGE_SIZES = ["A4", "Letter"] as const;
export type RenderPageSize = (typeof RENDER_PAGE_SIZES)[number];

export interface RenderPdfInput {
  /**
   * The complete HTML document to render.
   *
   * Callers render **their own** template from typed data and escape every
   * interpolated value; never pass model- or feed-authored markup through here
   * (an HTML injection would run inside the renderer's browser context).
   */
  readonly html: string;
  readonly pageSize?: RenderPageSize;
}

export interface RenderedDocument {
  readonly bytes: Uint8Array;
  /** Page count, when the engine can report it. */
  readonly pages?: number;
}

export interface RenderCapabilities {
  readonly available: boolean;
  /** Which engine backs this port, as the adapter names itself. */
  readonly provider: string;
  readonly detail?: string;
}

export interface RenderPort {
  capabilities(): RenderCapabilities;
  renderPdf(input: RenderPdfInput): Promise<RenderedDocument>;
}
