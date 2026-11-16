import { z } from "zod";

import { IdSchema } from "./ids.js";

/**
 * The agent asks a person to act in its browser: `browser.request_handoff`.
 * Its task waits — durably, like
 * `operator.ask_user` — until the person hands the page back from the live
 * view (`done` or `failed`), the wait times out, or it is cancelled (the task
 * stopped, the session closed).
 *
 * Kept free of other contract modules so the wait contracts can import it.
 */

export const BROWSER_REQUEST_HANDOFF_TOOL_ID = "browser.request_handoff";

export const BROWSER_HANDOFF_REASONS = ["sign-in", "mfa", "captcha", "payment", "consent", "other"] as const;
export type BrowserHandoffReason = (typeof BROWSER_HANDOFF_REASONS)[number];
/** `operator`: the person took the page while the agent was using it, and its browser call waited. */
export const BROWSER_HANDOFF_WAIT_REASONS = [...BROWSER_HANDOFF_REASONS, "operator"] as const;

export const BROWSER_HANDOFF_INSTRUCTIONS_MAX = 500;
export const BROWSER_HANDOFF_DEFAULT_MINUTES = 15;
export const BROWSER_HANDOFF_MAX_MINUTES = 60;

/** What the model asks for. */
export const BrowserRequestHandoffInputSchema = z.strictObject({
  sessionId: z.string().min(1).max(128).describe("The browser session the person should act in"),
  reason: z.enum(BROWSER_HANDOFF_REASONS).describe("Why a person must act in the page"),
  instructions: z
    .string()
    .min(1)
    .max(BROWSER_HANDOFF_INSTRUCTIONS_MAX)
    .describe(
      'What the person should do, shown to them: "Sign in to example.com, then hand back". Never ask for a password or code to be told to you.',
    ),
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(BROWSER_HANDOFF_MAX_MINUTES)
    .optional()
    .describe(`How long to wait, in minutes (default ${BROWSER_HANDOFF_DEFAULT_MINUTES})`),
});
export type BrowserRequestHandoffInput = z.infer<typeof BrowserRequestHandoffInputSchema>;

/**
 * What a handoff wait records, and `task.waiting` carries: the session by its
 * browser-history id (the live view's), why, and what the person is asked to do.
 */
export const BrowserHandoffSchema = z.strictObject({
  sessionId: IdSchema,
  reason: z.enum(BROWSER_HANDOFF_WAIT_REASONS),
  instructions: z.string().max(BROWSER_HANDOFF_INSTRUCTIONS_MAX).optional(),
});
export type BrowserHandoff = z.infer<typeof BrowserHandoffSchema>;

/** How the person handed back, on the settled wait: `done` or `failed` and how long they had the page. */
export const BrowserHandoffSettlementSchema = z.strictObject({
  outcome: z.enum(["done", "failed"]),
  controlledMs: z.number().int().nonnegative(),
});

/** What the model receives once the wait settles: the outcome, the person's note, and the page as it is now. */
export interface BrowserHandoffResult {
  readonly outcome: "done" | "failed" | "timeout" | "cancelled";
  readonly reason: (typeof BROWSER_HANDOFF_WAIT_REASONS)[number];
  readonly note?: string;
  readonly controlledMs: number;
  /** A fresh observation (a new epoch): verify the page, never assume it worked. */
  readonly page?: unknown;
  readonly detail?: string;
}

/**
 * What the workflow needs to hand a session to a person (the owner implements
 * it over its browser and live view). Absent where nobody could take a page
 * over — no live view — and the tool is then not offered.
 */
export interface BrowserHandoffPort {
  /** The session's live-view id, if it is the task's (or its tree's) and open. */
  target(input: {
    readonly taskId: string;
    readonly sessionId: string;
  }): Promise<{ readonly historyId: string } | { readonly refusal: string }>;
  /** Who acts in it now (`agent` when it is not known). */
  controlState(input: { readonly taskId: string; readonly sessionId: string }): "agent" | "requested" | "operator";
  /** The agent's request, once its wait is active: the session waits for a person, and a remote chat is told where to go. */
  request(input: {
    readonly taskId: string;
    readonly historyId: string;
    readonly handoff: BrowserHandoff;
    readonly waitId: string;
  }): Promise<void>;
  /** The wait settled without the person (a timeout): the agent acts again. */
  end(input: { readonly historyId: string; readonly outcome: "timeout" | "cancelled" }): void;
  /** A fresh look at the page once it is handed back. */
  observe(sessionId: string): Promise<unknown>;
  /** Whether a wait of this id was recorded: a replayed browser call that waited for a person finds its wait again. */
  recorded(waitId: string): Promise<boolean>;
}
