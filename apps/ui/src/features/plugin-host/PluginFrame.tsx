import type { LiveWatch, TaviClient } from "@tavi/client";
import {
  HostToPluginMessageSchema,
  PLUGIN_UI_ABI,
  PLUGIN_UI_HIDDEN_UNWATCH_MS,
  PLUGIN_UI_MAX_MESSAGE_BYTES,
  PLUGIN_UI_MAX_MESSAGES_PER_SECOND,
  PLUGIN_UI_THEME_TOKENS,
  PluginToHostMessageSchema,
  pluginUiUrl,
  type HostToPluginMessage,
  type PluginUiChannel,
  type PluginUiContext,
  type PluginUiNavigation,
  type PluginUiPlacement,
  type PluginUiShortcut,
  type PluginUiSlot,
  type PluginUiTheme,
} from "@tavi/contracts";
import { createContext, useContext, useEffect, useRef, type CSSProperties } from "react";

import { reportFlood } from "./floods.js";
import { contributionKey, type ResolvedContribution } from "./slots.js";
import { prefersReducedMotion } from "../../lib/motion.js";

/**
 * One UI plugin contribution, shown: its document in a sandboxed, opaque-origin iframe, and the host's
 * side of the `tavi.ui/1` ABI.
 *
 * - **Isolation.** `sandbox="allow-scripts"` and nothing else: no
 *   same-origin, pop-ups, forms, modals, downloads or top navigation. The
 *   page reaches the canvas only by `postMessage`, and only messages from
 *   its own window are read.
 * - **Validation.** Every message is checked against the ABI in both
 *   directions; one that is malformed or over 64 KiB is dropped. A plugin
 *   that sends more than 200 a second is paused for good and reported.
 * - **Channels.** A `watch` is honoured only for a channel the contribution
 *   declared; its messages come back as `channel` messages, each frame with
 *   the `seq` the plugin acknowledges. The acknowledgement is the stream's
 *   credit, relayed to the owner.
 * - **Shortcuts.** A forwarded host shortcut is honoured only while the frame
 *   has focus: the reader pressed it there.
 * - **Context.** `init` once the page says `ready`, then `theme`, `size`,
 *   `visibility` and `context` as they change. Hidden (the browser tab, the
 *   panel, the slot, the phone sheet at half), it is told so, and its watch
 *   ends after 2 s; shown again, the watch is opened again.
 * - **Teardown.** Unmounting ends the watch: a parent that drops a revoked
 *   plugin's contribution tears it all down.
 */

/** What a frame needs of the client: live watches, where the page has the live view. */
export type PluginFrameClient = Partial<Pick<TaviClient, "liveWatch">>;
/** A client with the live view: what the Browser's frames and a takeover need. */
export type LivePluginFrameClient = Pick<TaviClient, "liveWatch">;

export interface PluginFrameProps {
  readonly resolved: ResolvedContribution;
  readonly slot: PluginUiSlot;
  readonly placement?: PluginUiPlacement | undefined;
  readonly context: PluginUiContext;
  readonly client: PluginFrameClient;
  /** Whether the place it is shown in is open: the panel, the slot, the sheet. The browser tab's own visibility is read here. */
  readonly visible: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Laid out as nothing (the `hidden` attribute), while it keeps its document. */
  readonly hidden?: boolean;
  /** The height the plugin asks for, clamped to its placement's bounds. */
  readonly onRequestHeight?: (px: number) => void;
  readonly onBadge?: (badge: { readonly count?: number | undefined; readonly dot?: boolean | undefined }) => void;
  readonly onNavigate?: (target: PluginUiNavigation) => void;
  readonly onShortcut?: (key: PluginUiShortcut) => void;
  /** The plugin sent too much and was paused. */
  readonly onFlood?: () => void;
  /** What the plugin's own code published for the chat in view: its `mod.state` channel, by key. */
  readonly modState?: Readonly<Record<string, unknown>> | undefined;
}

/** The canvas's theme as a plugin gets it: its tokens' computed values, and the scheme. */
function currentTheme(): PluginUiTheme {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const token of PLUGIN_UI_THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value !== "") tokens[token] = value.slice(0, 200);
  }
  const dark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { tokens, colorScheme: dark ? "dark" : "light" };
}

/** The host's side of one frame: its state and what acts on it, for the frame's life. */
interface FrameController {
  ready: boolean;
  paused: boolean;
  sent: number[];
  seq: number;
  /** Frames awaiting the plugin's ack, by the seq it was given. */
  readonly acks: Map<number, () => void>;
  wanted:
    | { readonly channel: PluginUiChannel; readonly sessionId?: string | undefined; readonly maxWidth?: number | undefined }
    | undefined;
  watch: Promise<LiveWatch | undefined> | undefined;
  hideTimer: ReturnType<typeof setTimeout> | undefined;
  shown: boolean;
  /** The plugin watches its `mod.state`: what it was last sent, by key. */
  modState: Readonly<Record<string, unknown>> | undefined;
  post(message: HostToPluginMessage): void;
  sendModState(): void;
  closeWatch(): void;
  openWatch(): void;
  visibility(): void;
}

/**
 * Whether something covers every plugin frame (the takeover surface): they are
 * then hidden, and end their watches as any hidden frame does, rather than
 * streaming behind it on the connection every tab shares.
 */
export const PluginFramesCoveredContext = createContext(false);

export function PluginFrame(props: PluginFrameProps) {
  const covered = useContext(PluginFramesCoveredContext);
  const { resolved, context } = props;
  const visible = props.visible && !covered;
  const frame = useRef<HTMLIFrameElement>(null);
  /** The latest props, for listeners registered once; `visible` as covering leaves it. */
  const latest = useRef({ ...props, visible });
  latest.current = { ...props, visible };
  const controller = useRef<FrameController | undefined>(undefined);
  const channels = resolved.contribution.channels;

  useEffect(() => {
    const shown = (): boolean => latest.current.visible && document.visibilityState === "visible";
    const size = (): { width: number; height: number } => ({
      width: Math.round(frame.current?.clientWidth ?? 0),
      height: Math.round(frame.current?.clientHeight ?? 0),
    });
    const state: FrameController = {
      ready: false,
      paused: false,
      sent: [],
      seq: 0,
      acks: new Map(),
      wanted: undefined,
      watch: undefined,
      hideTimer: undefined,
      shown: false,
      modState: undefined,
      post(message) {
        const parsed = HostToPluginMessageSchema.safeParse(message);
        if (!parsed.success) return;
        frame.current?.contentWindow?.postMessage(parsed.data, "*");
      },
      sendModState() {
        const sent = state.modState;
        if (sent === undefined || !state.ready) return;
        const now = latest.current.modState ?? {};
        // Each key that changed since it was last sent, in order; a key no longer there is cleared (`value: null`).
        for (const [key, value] of Object.entries(now)) {
          if (sent[key] === value) continue;
          state.seq += 1;
          state.post({ abi: PLUGIN_UI_ABI, type: "channel", channel: "mod.state", seq: state.seq, message: { key, value } });
        }
        for (const key of Object.keys(sent)) {
          if (key in now) continue;
          state.seq += 1;
          state.post({ abi: PLUGIN_UI_ABI, type: "channel", channel: "mod.state", seq: state.seq, message: { key, value: null } });
        }
        state.modState = now;
      },
      closeWatch() {
        const watch = state.watch;
        state.watch = undefined;
        state.acks.clear();
        void watch?.then((open) => open?.close());
      },
      openWatch() {
        const wanted = state.wanted;
        const { taskId, workspaceId } = latest.current.context;
        // A frame shown where the page has no live view (Welcome, the heartbeat panel) asks for none.
        const liveWatch = latest.current.client.liveWatch;
        if (
          wanted === undefined ||
          state.watch !== undefined ||
          state.paused ||
          taskId === undefined ||
          !shown() ||
          liveWatch === undefined
        )
          return;
        const sessionId = wanted.sessionId ?? latest.current.context.sessionId;
        /** Ended by the owner, refused or failed: forgotten, so the next showing or context opens it again. */
        const lost = (): void => {
          if (state.watch !== opening) return;
          state.watch = undefined;
          state.acks.clear();
        };
        const opening: Promise<LiveWatch | undefined> = liveWatch
          .call(latest.current.client, taskId, {
            workspaceId,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(wanted.maxWidth === undefined ? {} : { maxWidth: wanted.maxWidth }),
            onMessage: (message, ack) => {
              if (state.watch !== opening) return;
              state.seq += 1;
              // Only a frame waits for the plugin: anything else needs no credit.
              if (message.kind === "frame") {
                state.acks.set(state.seq, ack);
                // Credit keeps this at two; a plugin that never acks cannot grow it.
                while (state.acks.size > 16) state.acks.delete(state.acks.keys().next().value ?? state.seq);
              } else {
                ack();
              }
              state.post({ abi: PLUGIN_UI_ABI, type: "channel", channel: wanted.channel, seq: state.seq, message });
            },
            onEnd: lost,
          })
          .then(
            (opened) => {
              if (opened.watch === undefined) lost();
              return opened.watch;
            },
            () => {
              lost();
              return undefined;
            },
          );
        state.watch = opening;
      },
      visibility() {
        const now = shown();
        if (state.ready && now !== state.shown) state.post({ abi: PLUGIN_UI_ABI, type: "visibility", visible: now });
        state.shown = now;
        if (now) {
          if (state.hideTimer !== undefined) clearTimeout(state.hideTimer);
          state.hideTimer = undefined;
          state.openWatch();
        } else if (state.hideTimer === undefined && state.watch !== undefined) {
          state.hideTimer = setTimeout(() => {
            state.hideTimer = undefined;
            if (!shown()) state.closeWatch();
          }, PLUGIN_UI_HIDDEN_UNWATCH_MS);
        }
      },
    };
    controller.current = state;

    const receive = (event: MessageEvent): void => {
      const own = frame.current?.contentWindow;
      if (own === null || own === undefined || event.source !== own || state.paused) return;
      // Flood guard: a sliding second.
      const now = Date.now();
      state.sent = state.sent.filter((at) => now - at < 1_000);
      state.sent.push(now);
      if (state.sent.length > PLUGIN_UI_MAX_MESSAGES_PER_SECOND) {
        state.paused = true;
        state.closeWatch();
        reportFlood(contributionKey(latest.current.resolved));
        latest.current.onFlood?.();
        return;
      }
      let bytes: number;
      try {
        bytes = JSON.stringify(event.data)?.length ?? 0;
      } catch {
        return;
      }
      if (bytes > PLUGIN_UI_MAX_MESSAGE_BYTES) return;
      const parsed = PluginToHostMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      const current = latest.current;
      switch (message.type) {
        case "ready":
          // A new document in the same frame (a reload): it starts from nothing.
          state.closeWatch();
          state.wanted = undefined;
          state.modState = undefined;
          state.seq = 0;
          state.ready = true;
          state.shown = shown();
          state.post({
            abi: PLUGIN_UI_ABI,
            type: "init",
            pluginId: current.resolved.pluginId,
            contributionId: current.resolved.contribution.id,
            slot: current.slot,
            context: current.context,
            channels: [...current.resolved.contribution.channels],
            theme: currentTheme(),
            size: size(),
            reducedMotion: prefersReducedMotion(),
            visible: state.shown,
          });
          return;
        case "watch":
          // Only a channel the contribution declared, and was approved with.
          if (!current.resolved.contribution.channels.includes(message.channel)) return;
          if (message.channel === "mod.state") {
            // Everything published so far, then each change.
            state.modState = {};
            state.sendModState();
            return;
          }
          if (message.channel !== "browser.live") return;
          state.closeWatch();
          state.wanted = { channel: message.channel, sessionId: message.sessionId, maxWidth: message.maxWidth };
          state.openWatch();
          return;
        case "unwatch":
          if (message.channel === "mod.state") {
            state.modState = undefined;
            return;
          }
          state.wanted = undefined;
          state.closeWatch();
          return;
        case "ack": {
          const ack = state.acks.get(message.seq);
          state.acks.delete(message.seq);
          ack?.();
          return;
        }
        case "requestHeight": {
          const height = current.placement?.height;
          const px = height === undefined ? message.px : Math.min(height.max, Math.max(height.min, message.px));
          current.onRequestHeight?.(px);
          return;
        }
        case "badge":
          current.onBadge?.({ count: message.count, dot: message.dot });
          return;
        case "navigate":
          current.onNavigate?.(message.target);
          return;
        case "shortcut":
          // Only a key the reader pressed in the frame: a plugin cannot press the
          // canvas's keys (Escape stops the running turn) on its own.
          if (document.activeElement !== frame.current) return;
          current.onShortcut?.(message.key);
          return;
      }
    };

    const themeChanged = (): void => {
      if (state.ready) state.post({ abi: PLUGIN_UI_ABI, type: "theme", theme: currentTheme() });
    };
    const schemes = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;
    const resize =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (state.ready) state.post({ abi: PLUGIN_UI_ABI, type: "size", ...size() });
          })
        : undefined;
    if (frame.current !== null) resize?.observe(frame.current);
    const visibility = (): void => state.visibility();
    window.addEventListener("message", receive);
    document.addEventListener("visibilitychange", visibility);
    schemes?.addEventListener?.("change", themeChanged);
    return () => {
      window.removeEventListener("message", receive);
      document.removeEventListener("visibilitychange", visibility);
      schemes?.removeEventListener?.("change", themeChanged);
      resize?.disconnect();
      if (state.hideTimer !== undefined) clearTimeout(state.hideTimer);
      state.closeWatch();
      controller.current = undefined;
    };
    // Once per frame: the latest props are read through `latest`.
  }, []);

  // The place it is shown in opened or closed.
  useEffect(() => controller.current?.visibility(), [visible]);

  // A new chat, or session: told, and a watch of the old one ends; the next is opened for the new one.
  const contextKey = `${context.workspaceId}|${context.taskId ?? ""}|${context.sessionId ?? ""}`;
  const firstContext = useRef(contextKey);
  useEffect(() => {
    if (contextKey === firstContext.current) return;
    firstContext.current = contextKey;
    const state = controller.current;
    if (state === undefined || !state.ready) return;
    state.post({ abi: PLUGIN_UI_ABI, type: "context", context: latest.current.context });
    // Another chat's values: what was sent is the old chat's, so a key the new
    // one lacks is cleared (`value: null`), and all of the new one's is sent again.
    if (state.modState !== undefined) {
      const keys = Object.keys(latest.current.modState ?? {});
      for (const key of Object.keys(state.modState)) {
        if (keys.includes(key)) continue;
        state.seq += 1;
        state.post({ abi: PLUGIN_UI_ABI, type: "channel", channel: "mod.state", seq: state.seq, message: { key, value: null } });
      }
      state.modState = {};
      state.sendModState();
    }
    state.closeWatch();
    state.visibility();
  }, [contextKey]);

  // What its plugin published changed: sent on, while it watches. After the context effect, so a new chat's values follow its `context`, once.
  useEffect(() => controller.current?.sendModState(), [props.modState]);

  return (
    <iframe
      ref={frame}
      className={props.className}
      style={props.style}
      hidden={props.hidden}
      // Named for a screen reader's frame list: its title, or which plugin it is and where, when the manifest gave none.
      title={frameTitle(resolved, props.slot)}
      src={pluginUiUrl(resolved, resolved.contribution.document)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow=""
      loading="lazy"
      data-plugin={resolved.pluginId}
      data-contribution={resolved.contribution.id}
      data-channels={channels.join(" ")}
    />
  );
}

/** A frame's accessible name: the contribution's title, else its plugin and slot ("acme.view, chat.panel.tab"). */
function frameTitle(resolved: Pick<ResolvedContribution, "pluginId" | "contribution">, slot: PluginUiSlot): string {
  const title = resolved.contribution.title.trim();
  return title === "" ? `${resolved.pluginId}, ${slot}` : title;
}
