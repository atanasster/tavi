import { z } from "zod";

import { BROWSER_ACTION_KINDS, BROWSER_WAIT_MAX_MS, STRUCTURED_DATA_TYPES } from "@tavi/contracts";

import { BROWSER_BATCH_MAX_STEPS } from "../approvals/call-assessors.js";

/** The browser tools' input schemas: what the model may send, and nothing it may not. */

export const BrowserSessionInputSchema = z.object({ sessionId: z.string().min(1).max(128) });
export const BrowserCaptureInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  forModel: z
    .boolean()
    .optional()
    .describe("true: you see the screenshot (never of a page with a password, payment or one-time-code field)"),
  marks: z.boolean().optional().describe("true: draw Set-of-Marks boxes and ref labels onto the screenshot copy"),
  ref: z.string().min(1).max(128).optional().describe("Crop to this element ref at full resolution (zoom)"),
  epoch: z.number().int().nonnegative().optional().describe("Observation epoch for ref when cropping"),
  region: z
    .object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional()
    .describe("Crop to this viewport region {x, y, width, height} in CSS pixels at full resolution (zoom)"),
});
export const BrowserObserveInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  scope: z
    .union([z.enum(["main", "dialog", "form"]), z.object({ ref: z.string().min(1).max(128), epoch: z.number().int().nonnegative() })])
    .optional()
    .describe(
      "Look at part of the page: main, dialog (an open one), form, or {ref, epoch} for one element's part (a results list, a date picker)",
    ),
  filter: z
    .enum(["interactive", "all"])
    .optional()
    .describe(
      "interactive: only what a person acts on (fields, buttons, links, options); all (default) adds headings (h1–h3, [role=heading]) and status text",
    ),
});
/**
 * The model names no workspace.
 *
 * A browser session's workspace decides which artifacts `browser.act
 * {kind:"upload"}` may hand to a page, and the destination page is
 * model-chosen. If the model could name the workspace, both sides of that
 * ownership check would be caller-controlled, and the model could hand one
 * workspace's artifacts to a page opened in another. So the session is always opened in the
 * *invoking* workspace, and the input has no workspace field at all: an
 * optional one invited a model to fill it with an invented id, and the
 * refusal that followed failed a task that asked for nothing unsafe. A key the
 * model sends anyway is stripped by the schema, never read.
 */
export const BrowserCreateSessionInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("The page to open first; the person is asked about the browser with this site named"),
  profile: z
    .enum(["persistent", "ephemeral"])
    .optional()
    .describe(
      'Session profile: "ephemeral" opens a logged-out context with no stored cookies (prefer for tasks that need no sign-in; it is never asked about for being signed in); "persistent" (default) uses the workspace profile, signed in as the person, and once the chat has read untrusted content opening it asks the person first',
    ),
});
export const NEEDS_ABSOLUTE_URL = "browser.create_session needs an absolute http(s) url, such as https://example.com";
export const BrowserReadInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  offset: z.number().int().nonnegative().optional().describe("Where to continue reading: the previous read's `nextOffset`"),
});
export const BrowserNavigateInputSchema = z.object({ sessionId: z.string().min(1).max(128), url: z.string().min(1).max(4096) });
export const BrowserStructuredInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  types: z
    .array(z.enum(STRUCTURED_DATA_TYPES))
    .min(1)
    .max(10)
    .optional()
    .describe("Only these schema.org types (default: every allowed one)"),
});
/** The most actions one `browser.batch` runs: five, or twelve that only fill a form (`longBatchRefusal`). */
const BROWSER_BATCH_MAX_ACTIONS = BROWSER_BATCH_MAX_STEPS;

export const BrowserActInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  ref: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("The element, from the session's latest observation; not needed for press, scroll, back, wait_for and the tab kinds"),
  epoch: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("The epoch of the observation the ref came from; leave it out to act on the latest observation's ref where it saw it"),
  kind: z.enum(BROWSER_ACTION_KINDS),
  value: z
    .string()
    .max(8_000)
    .optional()
    .describe(
      "type: the text. select: the option's label or value. press: the key, such as Enter, ArrowDown, Escape, Control+A. scroll: down, up, top, bottom, left or right. wait_for: text to wait for. open_in_tab: the URL, when no ref is given",
    ),
  toRef: z.string().min(1).max(128).optional().describe("drag: destination element ref from the same observation"),
  dx: z.number().min(-4096).max(4096).optional().describe("drag: horizontal offset in CSS pixels from ref"),
  dy: z.number().min(-4096).max(4096).optional().describe("drag: vertical offset in CSS pixels from ref"),
  tab: z.number().int().nonnegative().optional().describe("tab, close_tab: the 0-based tab index from observation.tabs"),
  mode: z
    .enum(["fill", "keys"])
    .optional()
    .describe(
      "type: keys types key by key and lists the suggestions a field opens (airports, cities, search boxes); fill (default) sets it at once",
    ),
  clear: z.boolean().optional().describe("type with mode keys: whether to clear the field before typing (default true; false appends)"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(BROWSER_WAIT_MAX_MS)
    .optional()
    .describe("wait_for: how long to wait; any other action: how long it may take before it is given up (default 8 s)"),
  artifactId: z.string().min(1).max(128).optional().describe("upload: an approved artifact to upload; give this or path"),
  path: z
    .string()
    .min(1)
    .max(4_096)
    .optional()
    .describe(
      "upload: a file in your working folder or an attached folder to upload (relative to your working folder, or absolute); give this or artifactId. The person approving the upload is shown its name, size and sha256",
    ),
  dialog: z
    .object({
      accept: z.literal(true),
      promptText: z.string().max(1_000).optional(),
    })
    .optional()
    .describe("Arm the next confirm or beforeunload dialog raised by this action to be accepted"),
});

/** One step of a batch: an act without a session, an upload or a download (they go alone). */
const BatchActionSchema = BrowserActInputSchema.omit({ sessionId: true, artifactId: true, path: true }).extend({
  kind: z.enum(["click", "type", "select", "hover", "drag", "press", "scroll", "back", "wait_for", "tab"]),
  optional: z
    .boolean()
    .optional()
    .describe("true: if this step fails or its element is missing or rejected, record it as skipped and continue the batch"),
});
export const BrowserBatchInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  actions: z.array(BatchActionSchema).min(1).max(BROWSER_BATCH_MAX_ACTIONS),
});
