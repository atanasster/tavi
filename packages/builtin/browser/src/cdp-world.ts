import type { CDPSession, Frame, Page } from "playwright";

/**
 * Reaching a frame over CDP: the frame tree's nodes, the session that reaches
 * a frame (its own process's, for an out-of-process one), and the hop an
 * isolated-world script answers with when what it reads is inside a
 * cross-origin child frame.
 */

/** A frame in CDP's frame tree (`Page.getFrameTree`), with its children. */
export interface CdpFrameNode {
  readonly frame: {
    readonly id: string;
    readonly url?: string | undefined;
    readonly name?: string | undefined;
    readonly securityOrigin?: string | undefined;
  };
  readonly childFrames?: readonly CdpFrameNode[] | undefined;
}

/** An isolated-world script's answer when what it reads is inside a cross-origin child frame: where to read there. */
export interface CrossOriginFrameHop {
  readonly __crossOriginFrame: true;
  readonly iframeIndex: number;
  readonly src: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly focused: boolean;
}

/** Whether a script's answer is a hop into a cross-origin child frame. */
export function isCrossOriginFrameHop(value: unknown): value is CrossOriginFrameHop {
  return typeof value === "object" && value !== null && (value as { readonly __crossOriginFrame?: unknown }).__crossOriginFrame === true;
}

function flattenCdpFrames(root: CdpFrameNode): CdpFrameNode[] {
  const out: CdpFrameNode[] = [root];
  for (const child of root.childFrames ?? []) {
    out.push(...flattenCdpFrames(child));
  }
  return out;
}

/**
 * The CDP frame node for `targetFrame` in `root`'s tree, or `undefined` when
 * it cannot be matched: a caller then reads nothing, and refuses, rather than
 * reading another frame's element at the same index.
 */
export function resolveCdpFrameNode(root: CdpFrameNode, page: Page, targetFrame?: Frame): CdpFrameNode | undefined {
  if (targetFrame === undefined || (typeof page.mainFrame === "function" && targetFrame === page.mainFrame())) {
    return root;
  }
  const nodes = flattenCdpFrames(root);
  const targetUrl = typeof targetFrame.url === "function" ? targetFrame.url() : "";
  const targetName = typeof targetFrame.name === "function" ? targetFrame.name() : "";
  if (typeof page.frames === "function") {
    const idx = page.frames().indexOf(targetFrame);
    if (idx >= 0 && nodes[idx] !== undefined && nodes[idx]!.frame.url === targetUrl) {
      return nodes[idx]!;
    }
  }
  // By name or address only when one frame bears it: the first of two alike may be the other.
  if (targetName !== "") {
    const byName = nodes.filter((node) => node.frame.name === targetName && (targetUrl === "" || node.frame.url === targetUrl));
    if (byName.length === 1) return byName[0];
  }
  if (targetUrl !== "") {
    const byUrl = nodes.filter((node) => node.frame.url === targetUrl);
    if (byUrl.length === 1) return byUrl[0];
  }
  return undefined;
}

/**
 * A CDP session that reaches `frame`, and the frame node to start from. An
 * out-of-process (cross-site) frame is reached through the session of its own
 * process: its own, or its nearest out-of-process ancestor's; any other frame
 * is found in the page's tree. `node` is `undefined` when the frame cannot be
 * found. The caller detaches the session.
 */
export async function frameCdpSession(
  page: Page,
  frame?: Frame,
): Promise<{ readonly cdp: CDPSession; readonly node: CdpFrameNode | undefined }> {
  const context = page.context();
  const main = typeof page.mainFrame === "function" ? page.mainFrame() : undefined;
  let cdp: CDPSession | undefined;
  // Playwright opens a session on a frame only when it is out of process.
  for (let candidate = frame; cdp === undefined && candidate !== undefined && candidate !== null && candidate !== main; ) {
    cdp = await context.newCDPSession(candidate).catch(() => undefined);
    candidate = typeof candidate.parentFrame === "function" ? (candidate.parentFrame() ?? undefined) : undefined;
  }
  const own = cdp !== undefined;
  cdp ??= await context.newCDPSession(page);
  try {
    const tree = await cdp.send("Page.getFrameTree");
    const root = tree.frameTree as CdpFrameNode;
    if (!own) return { cdp, node: resolveCdpFrameNode(root, page, frame) };
    const targetUrl = frame !== undefined && typeof frame.url === "function" ? frame.url() : "";
    // The process's own tree, rooted at its top frame: the frame itself, or one of its descendants by address.
    const descendants = flattenCdpFrames(root).filter((candidate) => candidate !== root && candidate.frame.url === targetUrl);
    const node = root.frame.url === targetUrl ? root : descendants.length === 1 ? descendants[0] : undefined;
    return { cdp, node };
  } catch (error) {
    // Best effort: the session is of no use; nothing waits on its detach.
    await cdp.detach().catch(() => undefined);
    throw error;
  }
}

/** The child frame a hop points at, or `undefined` when no single child matches it. */
export function nextCdpChildFrame(current: CdpFrameNode, hop: CrossOriginFrameHop): CdpFrameNode | undefined {
  const children = current.childFrames ?? [];
  if (
    hop.iframeIndex >= 0 &&
    hop.iframeIndex < children.length &&
    children[hop.iframeIndex] !== undefined &&
    hop.src !== "" &&
    children[hop.iframeIndex]!.frame.url === hop.src
  ) {
    return children[hop.iframeIndex];
  }
  if (hop.src !== "") {
    const exactChildren = children.filter((child) => child.frame.url === hop.src);
    if (exactChildren.length === 1) return exactChildren[0];
  }
  // By name only when one child bears it: a frame matched by place or a partial address alone may be another,
  // and facts read there would answer for the wrong element. No match refuses.
  if (hop.name !== "") {
    const byName = children.filter((child) => child.frame.name === hop.name);
    if (byName.length === 1) return byName[0];
  }
  return undefined;
}

/** Where an isolated-world read looks: at a point, by match index, or the focused element. */
export type IsolatedWorldAt = { readonly x: number; readonly y: number } | { readonly index: number } | "focused";

/** What an isolated-world read runs, and how it treats a page that throws. */
export interface IsolatedWorldRead {
  /** The isolated world's name, one per kind of read. */
  readonly worldName: string;
  /** The script to evaluate, for where it looks in the frame it runs in. */
  readonly expression: (at: IsolatedWorldAt) => string;
  /** Whether a script that throws, or answers nothing, throws here rather than answering `undefined`. */
  readonly requireAnswer?: boolean;
}

/**
 * Evaluates a read in an isolated world of `frame` (the main frame when omitted), following the script's answer into
 * a cross-origin child frame — at most eight hops — until it answers for the element itself. `"unknown"` when a frame
 * along the way cannot be found. The CDP session is detached either way.
 */
export async function withIsolatedWorld<Facts>(
  page: Page,
  frame: Frame | undefined,
  at: IsolatedWorldAt,
  read: IsolatedWorldRead,
): Promise<Facts | "unknown"> {
  const { cdp, node } = await frameCdpSession(page, frame);
  try {
    if (node === undefined) return "unknown";
    let currentNode = node;
    let currentAt = at;
    for (let depth = 0; depth < 8; depth += 1) {
      const world = await cdp.send("Page.createIsolatedWorld", {
        frameId: currentNode.frame.id,
        worldName: read.worldName,
      });
      const answer = await cdp.send("Runtime.evaluate", {
        expression: read.expression(currentAt),
        contextId: world.executionContextId,
        returnByValue: true,
      });
      if (read.requireAnswer === true && (answer.exceptionDetails !== undefined || answer.result.value === undefined))
        throw new Error(answer.exceptionDetails?.text ?? "no answer from the page");
      const value = answer.result.value as unknown;
      if (isCrossOriginFrameHop(value)) {
        const nextNode = nextCdpChildFrame(currentNode, value);
        if (nextNode === undefined) return "unknown";
        currentNode = nextNode;
        currentAt = value.focused ? "focused" : { x: value.x, y: value.y };
        continue;
      }
      return value as Facts | "unknown";
    }
    return "unknown";
  } finally {
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await cdp.detach().catch(() => undefined);
  }
}
