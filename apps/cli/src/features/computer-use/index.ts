import {
  TOOL_MEDIA_KEY,
  toLogicalPoint,
  type BrowserCaptureScale,
  type BrowserPointerAction,
  type ModelMessage,
  type ModelOutcome,
  type ModelRequest,
  type ModelToolCall,
  type ModelToolDescriptor,
} from "@tavi/contracts";
import { z } from "zod";

/**
 * Normalized computer-use action union and vendor adapters (generic function tool,
 * Anthropic computer toolset / versioned computer tools, OpenAI computer tool).
 */

export const GENERIC_VISION_TOOL_ID = "browser.vision_act";
const NATIVE_COMPUTER_TOOL_ID = "computer";

const GenericActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click_ref"), ref: z.string().min(1).max(128) }),
  z.object({ action: z.literal("type_ref"), ref: z.string().min(1).max(128), text: z.string().min(1).max(2_000) }),
  z.object({ action: z.literal("click"), x: z.number(), y: z.number(), double: z.boolean().optional() }),
  z.object({ action: z.literal("type"), text: z.string().min(1).max(2_000) }),
  z.object({ action: z.literal("press"), key: z.string().min(1).max(40) }),
  z.object({ action: z.literal("scroll"), x: z.number(), y: z.number(), dx: z.number(), dy: z.number() }),
  z.object({ action: z.literal("drag"), x: z.number(), y: z.number(), toX: z.number(), toY: z.number() }),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(5_000) }),
  z.object({ action: z.literal("done"), summary: z.string().max(4_000) }),
]);

/** The generic vision model's one function tool. */
const GENERIC_VISION_TOOL: ModelToolDescriptor = {
  id: GENERIC_VISION_TOOL_ID,
  name: "vision_act",
  description: "One action on the page you see: click_ref, type_ref, click, type, press, scroll, drag, wait, or done with a summary.",
  inputJsonSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["click_ref", "type_ref", "click", "type", "press", "scroll", "drag", "wait", "done"],
      },
      ref: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      double: { type: "boolean" },
      text: { type: "string" },
      key: { type: "string" },
      dx: { type: "number" },
      dy: { type: "number" },
      toX: { type: "number" },
      toY: { type: "number" },
      ms: { type: "integer" },
      summary: { type: "string" },
    },
    required: ["action"],
  },
};

export type ComputerAction =
  | BrowserPointerAction
  | { readonly kind: "click_ref"; readonly ref: string }
  | { readonly kind: "type_ref"; readonly ref: string; readonly text: string }
  | { readonly kind: "screenshot" }
  | { readonly kind: "zoom"; readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }
  | { readonly kind: "done"; readonly summary: string }
  | { readonly kind: "unsupported"; readonly action: string; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** Scales a pointer action's coordinates from captured image pixels to logical CSS/display coordinates. */
export function scaleComputerPointerAction(action: BrowserPointerAction, scale?: BrowserCaptureScale): BrowserPointerAction {
  switch (action.kind) {
    case "click": {
      const pt = toLogicalPoint({ x: action.x, y: action.y }, scale);
      return { ...action, x: pt.x, y: pt.y };
    }
    case "scroll": {
      const pt = toLogicalPoint({ x: action.x, y: action.y }, scale);
      return { ...action, x: pt.x, y: pt.y };
    }
    case "drag": {
      const from = toLogicalPoint({ x: action.x, y: action.y }, scale);
      const to = toLogicalPoint({ x: action.toX, y: action.toY }, scale);
      return { ...action, x: from.x, y: from.y, toX: to.x, toY: to.y };
    }
    case "type":
    case "press":
    case "wait":
      return action;
  }
}

/** Parses an input object from the generic `vision_act` function tool. */
export function parseGenericComputerAction(input: unknown): ComputerAction {
  const parsed = GenericActionSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid", reason: parsed.error.issues.map((issue) => issue.message).join("; ") };
  const value = parsed.data;
  switch (value.action) {
    case "click_ref":
      return { kind: "click_ref", ref: value.ref };
    case "type_ref":
      return { kind: "type_ref", ref: value.ref, text: value.text };
    case "click":
      return { kind: "click", x: value.x, y: value.y, ...(value.double === true ? { double: true } : {}) };
    case "type":
      return { kind: "type", text: value.text };
    case "press":
      return { kind: "press", key: value.key };
    case "scroll":
      return { kind: "scroll", x: value.x, y: value.y, dx: value.dx, dy: value.dy };
    case "drag":
      return { kind: "drag", x: value.x, y: value.y, toX: value.toX, toY: value.toY };
    case "wait":
      return { kind: "wait", ms: value.ms };
    case "done":
      return { kind: "done", summary: value.summary };
  }
}

const ANTHROPIC_KEY_ALIASES: Readonly<Record<string, string>> = {
  return: "Enter",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  space: " ",
  back_space: "Backspace",
  backspace: "Backspace",
  tab: "Tab",
  page_down: "PageDown",
  pagedown: "PageDown",
  page_up: "PageUp",
  pageup: "PageUp",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

function normalizeAnthropicKey(raw: string): string {
  const trimmed = raw.trim();
  const mapped = ANTHROPIC_KEY_ALIASES[trimmed.toLowerCase()];
  if (mapped !== undefined) return mapped;
  if (trimmed.includes("+")) {
    return trimmed
      .split("+")
      .map((part) => {
        const p = part.trim();
        const lower = p.toLowerCase();
        if (lower === "ctrl" || lower === "control") return "Control";
        if (lower === "alt" || lower === "option") return "Alt";
        if (lower === "shift") return "Shift";
        if (lower === "super" || lower === "cmd" || lower === "command" || lower === "meta") return "Meta";
        return ANTHROPIC_KEY_ALIASES[lower] ?? p;
      })
      .join("+");
  }
  return trimmed;
}

interface RawAnthropicComputerInput {
  readonly action?: unknown;
  readonly coordinate?: unknown;
  readonly start_coordinate?: unknown;
  readonly region?: unknown;
  readonly text?: unknown;
  readonly scroll_direction?: unknown;
  readonly scroll_amount?: unknown;
  readonly duration?: unknown;
  readonly require_confirmation?: unknown;
  readonly safety_confirmation?: unknown;
}

/** Parses one Anthropic `computer` tool_use input (`computer_20250124`, `computer_20251124`, or `computerToolset_20260801`). */
export function parseAnthropicComputerAction(
  input: unknown,
): ComputerAction | { readonly kind: "safety_refusal"; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { kind: "invalid", reason: "computer tool input must be an object" };
  }
  const record = input as RawAnthropicComputerInput;
  if (record.require_confirmation === true || typeof record.safety_confirmation === "string") {
    return {
      kind: "safety_refusal",
      reason:
        typeof record.safety_confirmation === "string"
          ? record.safety_confirmation
          : "vendor requested confirmation before executing this computer action",
    };
  }
  const action = typeof record.action === "string" ? record.action : "";
  // A pointer action with keys held (`text`: "shift", "cmd") is not the plain action: never run as one. Only `type`
  // and `key` read `text` as what they do.
  if (action !== "type" && action !== "key" && action !== "hold_key" && typeof record.text === "string" && record.text.trim() !== "")
    return { kind: "invalid", reason: `${action} with keys held is not supported in browser computer use` };
  const coord =
    Array.isArray(record.coordinate) &&
    record.coordinate.length === 2 &&
    typeof record.coordinate[0] === "number" &&
    typeof record.coordinate[1] === "number"
      ? ({ x: record.coordinate[0], y: record.coordinate[1] } as const)
      : undefined;
  switch (action) {
    case "screenshot":
      return { kind: "screenshot" };
    case "zoom": {
      const region = record.region;
      if (
        !Array.isArray(region) ||
        region.length !== 4 ||
        typeof region[0] !== "number" ||
        typeof region[1] !== "number" ||
        typeof region[2] !== "number" ||
        typeof region[3] !== "number" ||
        !Number.isFinite(region[0]) ||
        !Number.isFinite(region[1]) ||
        !Number.isFinite(region[2]) ||
        !Number.isFinite(region[3])
      ) {
        return { kind: "invalid", reason: "zoom requires a 4-number region [x1, y1, x2, y2]" };
      }
      const x1 = region[0];
      const y1 = region[1];
      const x2 = region[2];
      const y2 = region[3];
      const width = x2 - x1;
      const height = y2 - y1;
      if (width <= 0 || height <= 0) {
        return { kind: "invalid", reason: "zoom region width and height must be positive" };
      }
      return { kind: "zoom", region: { x: x1, y: y1, width, height } };
    }
    case "left_click":
    case "double_click": {
      if (coord === undefined) return { kind: "invalid", reason: `${action} requires coordinate [x, y]` };
      return { kind: "click", x: coord.x, y: coord.y, ...(action === "double_click" ? { double: true } : {}) };
    }
    case "left_click_drag": {
      const start =
        Array.isArray(record.start_coordinate) &&
        record.start_coordinate.length === 2 &&
        typeof record.start_coordinate[0] === "number" &&
        typeof record.start_coordinate[1] === "number"
          ? ({ x: record.start_coordinate[0], y: record.start_coordinate[1] } as const)
          : undefined;
      if (start === undefined || coord === undefined) {
        return { kind: "invalid", reason: "left_click_drag requires start_coordinate [x, y] and coordinate [toX, toY]" };
      }
      return { kind: "drag", x: start.x, y: start.y, toX: coord.x, toY: coord.y };
    }
    case "type": {
      if (typeof record.text !== "string" || record.text === "") {
        return { kind: "invalid", reason: "type requires non-empty text" };
      }
      return { kind: "type", text: record.text };
    }
    case "key": {
      if (typeof record.text !== "string" || record.text.trim() === "") {
        return { kind: "invalid", reason: "key requires non-empty key text" };
      }
      return { kind: "press", key: normalizeAnthropicKey(record.text) };
    }
    case "scroll": {
      const x = coord?.x ?? 640;
      const y = coord?.y ?? 360;
      const amount = typeof record.scroll_amount === "number" && Number.isFinite(record.scroll_amount) ? record.scroll_amount : 3;
      const delta = Math.round(amount * 100);
      const dir = record.scroll_direction;
      if (dir === "up") return { kind: "scroll", x, y, dx: 0, dy: -delta };
      if (dir === "down") return { kind: "scroll", x, y, dx: 0, dy: delta };
      if (dir === "left") return { kind: "scroll", x, y, dx: -delta, dy: 0 };
      if (dir === "right") return { kind: "scroll", x, y, dx: delta, dy: 0 };
      return { kind: "invalid", reason: "scroll requires scroll_direction up, down, left, or right" };
    }
    case "wait": {
      const seconds = typeof record.duration === "number" && Number.isFinite(record.duration) ? record.duration : 1;
      const ms = Math.min(5_000, Math.max(0, Math.round(seconds * 1_000)));
      return { kind: "wait", ms };
    }
    case "right_click":
    case "middle_click":
    case "triple_click":
    case "mouse_move":
    case "left_mouse_down":
    case "left_mouse_up":
    case "hold_key":
    case "cursor_position":
      return {
        kind: "unsupported",
        action,
        reason: `${action} is not supported in browser computer use; use left_click, double_click, left_click_drag, scroll, type, or key`,
      };
    default:
      return { kind: "invalid", reason: `unknown computer action: ${action || "<empty>"}` };
  }
}

interface RawOpenAiComputerCallInput {
  readonly actions?: unknown;
  readonly action?: unknown;
  readonly pendingSafetyChecks?: unknown;
  readonly pending_safety_checks?: unknown;
}

interface RawOpenAiComputerAction {
  readonly type?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly button?: unknown;
  readonly path?: unknown;
  readonly scrollX?: unknown;
  readonly scroll_x?: unknown;
  readonly scrollY?: unknown;
  readonly scroll_y?: unknown;
  readonly text?: unknown;
  readonly keys?: unknown;
}

/** Parses an OpenAI `computer_call` input (`{ actions?, action?, pendingSafetyChecks? }`). */
export function parseOpenAiComputerCall(
  input: unknown,
):
  | { readonly kind: "safety_refusal"; readonly reason: string }
  | { readonly kind: "actions"; readonly actions: readonly ComputerAction[] } {
  if (typeof input !== "object" || input === null) {
    return { kind: "actions", actions: [{ kind: "invalid", reason: "computer_call input must be an object" }] };
  }
  const record = input as RawOpenAiComputerCallInput;
  const pendingChecks = Array.isArray(record.pendingSafetyChecks)
    ? record.pendingSafetyChecks
    : Array.isArray(record.pending_safety_checks)
      ? record.pending_safety_checks
      : [];
  if (pendingChecks.length > 0) {
    const messages = pendingChecks
      .map((check) => {
        if (typeof check !== "object" || check === null) return "vendor safety check triggered";
        const c = check as { readonly message?: unknown; readonly code?: unknown };
        if (typeof c.message === "string" && c.message.trim() !== "") return c.message.trim();
        if (typeof c.code === "string" && c.code.trim() !== "") return c.code.trim();
        return "vendor safety check triggered";
      })
      .join("; ");
    return { kind: "safety_refusal", reason: messages };
  }
  const rawActions = Array.isArray(record.actions)
    ? record.actions
    : record.action !== undefined && record.action !== null
      ? [record.action]
      : [];
  if (rawActions.length === 0) {
    return { kind: "actions", actions: [{ kind: "invalid", reason: "computer_call contained no actions" }] };
  }
  const mapped: ComputerAction[] = rawActions.map((raw): ComputerAction => {
    if (typeof raw !== "object" || raw === null) {
      return { kind: "invalid", reason: "computer action must be an object" };
    }
    const item = raw as RawOpenAiComputerAction;
    const type = typeof item.type === "string" ? item.type : "";
    // A pointer action with keys held (shift-click, a modifier drag) is not the plain action: never run as one.
    if (type !== "keypress" && Array.isArray(item.keys) && item.keys.some((key) => typeof key === "string" && key.trim() !== ""))
      return { kind: "invalid", reason: `${type} with keys held is not supported in browser computer use` };
    switch (type) {
      case "screenshot":
        return { kind: "screenshot" };
      case "click": {
        if (typeof item.x !== "number" || typeof item.y !== "number") {
          return { kind: "invalid", reason: "click requires numeric x and y" };
        }
        const button = typeof item.button === "string" ? item.button : "left";
        if (button !== "left") {
          return {
            kind: "unsupported",
            action: `click(${button})`,
            reason: `${button}-button click is not supported in browser computer use; use left click`,
          };
        }
        return { kind: "click", x: item.x, y: item.y };
      }
      case "double_click": {
        if (typeof item.x !== "number" || typeof item.y !== "number") {
          return { kind: "invalid", reason: "double_click requires numeric x and y" };
        }
        return { kind: "click", x: item.x, y: item.y, double: true };
      }
      case "drag": {
        const path = Array.isArray(item.path) ? item.path : [];
        const first = path[0] as { readonly x?: unknown; readonly y?: unknown } | undefined;
        const last = path.at(-1) as { readonly x?: unknown; readonly y?: unknown } | undefined;
        if (
          path.length < 2 ||
          typeof first?.x !== "number" ||
          typeof first?.y !== "number" ||
          typeof last?.x !== "number" ||
          typeof last?.y !== "number"
        ) {
          return { kind: "invalid", reason: "drag requires a path of at least 2 points" };
        }
        return { kind: "drag", x: first.x, y: first.y, toX: last.x, toY: last.y };
      }
      case "scroll": {
        if (typeof item.x !== "number" || typeof item.y !== "number") {
          return { kind: "invalid", reason: "scroll requires numeric x and y" };
        }
        const dx = typeof item.scrollX === "number" ? item.scrollX : typeof item.scroll_x === "number" ? item.scroll_x : 0;
        const dy = typeof item.scrollY === "number" ? item.scrollY : typeof item.scroll_y === "number" ? item.scroll_y : 0;
        return { kind: "scroll", x: item.x, y: item.y, dx, dy };
      }
      case "type": {
        if (typeof item.text !== "string" || item.text === "") {
          return { kind: "invalid", reason: "type requires non-empty text" };
        }
        return { kind: "type", text: item.text };
      }
      case "keypress": {
        const keys = Array.isArray(item.keys) ? item.keys.filter((k): k is string => typeof k === "string" && k.trim() !== "") : [];
        if (keys.length === 0) return { kind: "invalid", reason: "keypress requires non-empty keys[]" };
        return { kind: "press", key: normalizeAnthropicKey(keys.join("+")) };
      }
      case "wait":
        return { kind: "wait", ms: 1_000 };
      case "move":
        return {
          kind: "unsupported",
          action: "move",
          reason: "move is not supported in browser computer use; use click, drag, or scroll",
        };
      default:
        return { kind: "invalid", reason: `unknown OpenAI computer action: ${type || "<empty>"}` };
    }
  });
  return { kind: "actions", actions: mapped };
}

interface ComputerCallBatch {
  readonly call: ModelToolCall;
  readonly actions: readonly ComputerAction[];
}

type ComputerTurnPlan =
  | { readonly kind: "finish"; readonly done: boolean; readonly summary: string }
  | { readonly kind: "safety_refusal"; readonly reason: string }
  | { readonly kind: "execute"; readonly batches: readonly ComputerCallBatch[] };

/**
 * A native computer tool's turn: a turn that calls nothing finishes (done when the model said something); otherwise
 * each call's actions run, unless one is a safety refusal, which stops the turn.
 */
function nativeComputerTurn(
  outcome: ModelOutcome,
  parseCall: (input: unknown) => ReturnType<typeof parseOpenAiComputerCall>,
): ComputerTurnPlan {
  if (outcome.toolCalls.length === 0) {
    const text = outcome.text.trim();
    return {
      kind: "finish",
      done: text !== "",
      summary: text === "" ? "the vision model stopped without saying it was done" : text,
    };
  }
  const batches: ComputerCallBatch[] = [];
  for (const call of outcome.toolCalls) {
    const parsed = parseCall(call.input);
    if (parsed.kind === "safety_refusal") return parsed;
    batches.push({ call, actions: parsed.actions });
  }
  return { kind: "execute", batches };
}

export interface ComputerUseAdapter {
  readonly vendor: "generic" | "anthropic" | "openai";
  readonly toolName: string;
  readonly maxShownScreenshots: number;
  seedInitialScreenshot(
    messages: ModelMessage[],
    image: { readonly artifactId: string; readonly mediaType: string },
    newId: (prefix: string) => string,
    now: () => string,
  ): void;
  requestFields(display: {
    readonly width: number;
    readonly height: number;
    readonly enableZoom?: boolean;
  }): Pick<ModelRequest, "tools" | "nativeComputer">;
  parseTurn(outcome: ModelOutcome): ComputerTurnPlan;
}

const genericComputerAdapter: ComputerUseAdapter = {
  vendor: "generic",
  toolName: GENERIC_VISION_TOOL_ID,
  maxShownScreenshots: 1,
  seedInitialScreenshot(messages, image, newId, now) {
    const first = newId("look");
    messages.push({
      id: newId("call"),
      role: "assistant",
      text: "",
      createdAt: now(),
      toolCalls: [{ id: first, name: GENERIC_VISION_TOOL_ID, input: { action: "look" } }],
    });
    messages.push({
      id: newId("result"),
      role: "tool",
      text: "",
      createdAt: now(),
      toolResults: [
        {
          toolCallId: first,
          toolName: GENERIC_VISION_TOOL_ID,
          isError: false,
          output: { note: "the page as it is now", [TOOL_MEDIA_KEY]: image },
        },
      ],
    });
  },
  requestFields() {
    return { tools: [GENERIC_VISION_TOOL] };
  },
  parseTurn(outcome) {
    const call = outcome.toolCalls[0];
    if (call === undefined) {
      return {
        kind: "finish",
        done: false,
        summary: outcome.text.trim() === "" ? "the vision model stopped without saying it was done" : outcome.text.trim(),
      };
    }
    const parsed = parseGenericComputerAction(call.input);
    if (parsed.kind === "done") {
      return { kind: "finish", done: true, summary: parsed.summary };
    }
    return { kind: "execute", batches: [{ call, actions: [parsed] }] };
  },
};

const anthropicComputerAdapter: ComputerUseAdapter = {
  vendor: "anthropic",
  toolName: NATIVE_COMPUTER_TOOL_ID,
  maxShownScreenshots: 3,
  seedInitialScreenshot(messages, image, newId, now) {
    const first = newId("look");
    messages.push({
      id: newId("call"),
      role: "assistant",
      text: "",
      createdAt: now(),
      toolCalls: [{ id: first, name: NATIVE_COMPUTER_TOOL_ID, input: { action: "screenshot" } }],
    });
    messages.push({
      id: newId("result"),
      role: "tool",
      text: "",
      createdAt: now(),
      toolResults: [
        {
          toolCallId: first,
          toolName: NATIVE_COMPUTER_TOOL_ID,
          isError: false,
          output: { [TOOL_MEDIA_KEY]: image },
        },
      ],
    });
  },
  requestFields(display) {
    return {
      tools: [],
      nativeComputer: {
        vendor: "anthropic",
        displayWidth: display.width,
        displayHeight: display.height,
        ...(display.enableZoom === undefined ? {} : { enableZoom: display.enableZoom }),
      },
    };
  },
  parseTurn(outcome) {
    return nativeComputerTurn(outcome, (input) => {
      const parsed = parseAnthropicComputerAction(input);
      return parsed.kind === "safety_refusal" ? parsed : { kind: "actions", actions: [parsed] };
    });
  },
};

const openaiComputerAdapter: ComputerUseAdapter = {
  vendor: "openai",
  toolName: NATIVE_COMPUTER_TOOL_ID,
  maxShownScreenshots: 3,
  seedInitialScreenshot(messages, image, _newId, _now) {
    const userIdx = messages.findIndex((m) => m.role === "user");
    if (userIdx >= 0) {
      const userMsg = messages[userIdx]!;
      messages[userIdx] = {
        ...userMsg,
        toolResults: [
          {
            toolCallId: "initial-screenshot",
            toolName: NATIVE_COMPUTER_TOOL_ID,
            isError: false,
            output: { [TOOL_MEDIA_KEY]: image },
          },
        ],
      };
    }
  },
  requestFields(display) {
    return {
      tools: [],
      nativeComputer: {
        vendor: "openai",
        displayWidth: display.width,
        displayHeight: display.height,
      },
    };
  },
  parseTurn(outcome) {
    return nativeComputerTurn(outcome, parseOpenAiComputerCall);
  },
};

export function computerAdapterFor(vendor?: "generic" | "anthropic" | "openai"): ComputerUseAdapter {
  if (vendor === "anthropic") return anthropicComputerAdapter;
  if (vendor === "openai") return openaiComputerAdapter;
  return genericComputerAdapter;
}
