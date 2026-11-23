import type { BrowserLiveFrame, BrowserLiveMessage, BrowserLiveSessionInfo, PluginToHostMessage } from "@tavi/contracts";

/**
 * The built-in live browser view, the page
 * the canvas frames for the `browser-view` role. It speaks only `tavi.ui/1`
 * with its host — it has no network and no access to the canvas — and is
 * deliberately plain: no framework, a few kilobytes.
 *
 * - **Stage.** Each frame's image is decoded off-screen and then swapped in,
 *   so it never flickers, and acknowledged once shown: that acknowledgement
 *   is the stream's whole pace. An action's box is drawn over it, mapped
 *   through the frame's own metadata, with a pulse on a click (none under
 *   reduced motion).
 * - **Chrome.** The address (host and path) and title, a status chip (Live,
 *   Loading, Paused, Hidden — sensitive page, Ended), a session switcher when
 *   the chat's task tree has several, Open in transcript and Expand.
 * - **Not live.** The session's last thumbnail, or its host's first letter.
 * - **Accessibility.** The image's text alternative is the page title; a
 *   polite region says each navigation and each hidden or ended state, never a
 *   frame; every control is reachable by keyboard; Escape and the panel's
 *   shortcut are forwarded to the canvas.
 * - **Language.** Its words are `ENGLISH`'s, by key; `init` and `locale` bring
 *   the canvas's language and the host-verified pack's words for it
 *   (`locales/<lang>.json`), each key it lacks said in English. The chip's
 *   `data-state` is a stable id, never its words.
 */

const ABI = "tavi.ui/1";
/** The widest frame asked for, in device pixels. */
const MAX_WIDTH = 960;
/** How much wider or narrower the view must be drawn before it asks for frames of the new width. */
const WATCH_STEP_PX = 64;
/** `ended`'s reason when the session's task ended: kept open, not over (`BROWSER_LIVE_ENDED_TASK`). */
const KEPT_REASON = "task-ended";

/** The status chip's states: its `data-state`, and the key of its words (`chip.<state>`). */
export const CHIP_STATES = ["waiting", "live", "loading", "paused", "hidden", "ended", "operator", "requested"] as const;
export type ChipState = (typeof CHIP_STATES)[number];

/**
 * The view's words in English, by key: what it says with no language pack, and
 * for any key a pack lacks. `{name}`s are filled in. `locales/bg.json` carries the same keys.
 */
export const ENGLISH = {
  "chip.waiting": "Waiting",
  "chip.live": "Live",
  "chip.loading": "Loading",
  "chip.paused": "Paused",
  "chip.hidden": "Hidden — sensitive page",
  "chip.ended": "Ended",
  "chip.operator": "You're in control",
  "chip.requested": "Needs you",
  "notice.kept": "Tavi has finished; the page is kept.",
  "notice.ended": "This browser session has ended.",
  "hidden.password-field.notice": "Hidden: this page has a password field.",
  "hidden.password-field.said": "The page is hidden: it has a password field.",
  "hidden.payment-field.notice": "Hidden: this page has a payment or one-time-code field.",
  "hidden.payment-field.said": "The page is hidden: it has a payment or one-time-code field.",
  "hidden.blocked-host.notice": "Hidden: this site is never shown.",
  "hidden.blocked-host.said": "The page is hidden: its site is never shown.",
  "hidden.other.notice": "Hidden: this page is not shown.",
  "hidden.other.said": "The page is hidden.",
  "say.navigated": "Now on {address}",
  "say.navigatedTitled": "Now on {address}, {title}",
  "say.pending": "Waiting for your approval to {action} here.",
  "say.paused": "The live view is paused.",
  "say.ended": "The browser session ended.",
  "session.numbered": "Session {number}",
  "session.subAgent": "sub-agent",
  "session.ofAgent": "{where} ({agent})",
  "view.label": "The agent's browser",
  "view.title": "Browser",
  "view.session": "Session",
  "button.transcript": "Open in transcript",
  "button.expand": "Expand",
} as const;
export type ViewerKey = keyof typeof ENGLISH;

/** A message as a pack carries it: a string, or plural forms (the view counts nothing, so `other` is said). */
type PackMessage = string | { readonly other: string };

/** `key`'s words: the pack's when it has them, else English; each `{name}` filled from `params`, an unknown one kept. */
export function wordsOf(
  messages: Readonly<Record<string, PackMessage>> | undefined,
  key: string,
  english: string,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const found = messages !== undefined && Object.hasOwn(messages, key) ? messages[key] : undefined;
  const template = typeof found === "string" ? found : typeof found?.other === "string" ? found.other : english;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

interface SessionView {
  info: BrowserLiveSessionInfo;
  /** The latest frame of it, shown or not. */
  frame: BrowserLiveFrame | undefined;
  hidden: string | undefined;
  ended: string | undefined;
  loading: boolean;
  /** The call behind its latest action, for Open in transcript. */
  callId: string | undefined;
}

export interface ViewerEnvironment {
  readonly window: Window;
  readonly document: Document;
  /** Where messages go: the canvas. */
  readonly host: { postMessage(message: unknown, targetOrigin: string): void };
  /** Whether a message came from the canvas. */
  readonly fromHost: (event: MessageEvent) => boolean;
  /** Decodes an image before it is shown; a test's is immediate. */
  readonly decode?: (src: string) => Promise<void>;
}

/** The host and path of a scrubbed URL, for the address line; the whole string when it is not one. */
export function addressOf(url: string | undefined): { readonly host: string; readonly path: string } {
  if (url === undefined) return { host: "", path: "" };
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname === "/" ? "" : parsed.pathname };
  } catch {
    return { host: url, path: "" };
  }
}

export function startViewer(env: ViewerEnvironment): { stop(): void } {
  const { document, window } = env;
  const $ = <T extends Element>(name: string): T => {
    const element = document.querySelector<T>(`[data-${name}]`);
    if (element === null) throw new Error(`the page has no [data-${name}]`);
    return element;
  };
  const chip = $<HTMLElement>("chip");
  const host = $<HTMLElement>("host");
  const path = $<HTMLElement>("path");
  const title = $<HTMLElement>("title");
  const switcher = $<HTMLElement>("switcher");
  const select = $<HTMLSelectElement>("sessions");
  const transcript = $<HTMLButtonElement>("transcript");
  const expand = $<HTMLButtonElement>("expand");
  const main = $<HTMLElement>("view");
  const sessionLabel = $<HTMLElement>("session-label");
  const stage = $<HTMLElement>("stage");
  const image = $<HTMLImageElement>("frame");
  const letter = $<HTMLElement>("letter");
  const box = $<HTMLElement>("box");
  const pulse = $<HTMLElement>("pulse");
  const notice = $<HTMLElement>("notice");
  const announce = $<HTMLElement>("announce");

  const send = (message: PluginToHostMessage): void => env.host.postMessage(message, "*");
  const decode =
    env.decode ??
    (async (src: string) => {
      const off = document.createElement("img");
      off.src = src;
      await off.decode();
    });

  const state = {
    taskId: undefined as string | undefined,
    slot: undefined as string | undefined,
    live: false,
    reducedMotion: false,
    sessions: new Map<string, SessionView>(),
    selected: undefined as string | undefined,
    /** The frame swap in progress, so frames are shown in order. */
    showing: Promise.resolve(),
    /** The pending hide of the last action's box. */
    boxTimer: undefined as number | undefined,
    /** The shown box, in document pixels: placed again on each frame, as the page scrolls. */
    boxRect: undefined as { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined,
    /** The session ids and labels the switcher lists, so it is rebuilt only when they change. */
    listed: "",
    /** The canvas's language and the pack's words for it, from `init` and `locale`. */
    locale: "en",
    messages: undefined as Readonly<Record<string, PackMessage>> | undefined,
  };
  const t = (key: ViewerKey, params?: Readonly<Record<string, string | number>>): string =>
    wordsOf(state.messages, key, ENGLISH[key], params);
  /** What the notice and the announcement say for each reason a page is not shown. */
  const hiddenText = (reason: string): { readonly notice: string; readonly said: string } => {
    const known = reason === "password-field" || reason === "payment-field" || reason === "blocked-host" ? reason : "other";
    return { notice: t(`hidden.${known}.notice`), said: t(`hidden.${known}.said`) };
  };
  /** The words the page's own markup carries, said again in the canvas's language. */
  const label = (): void => {
    document.documentElement.lang = state.locale;
    document.title = t("view.title");
    main.setAttribute("aria-label", t("view.label"));
    sessionLabel.textContent = t("view.session");
    transcript.textContent = t("button.transcript");
    expand.textContent = t("button.expand");
  };
  /** The language `init` or `locale` says: a known code and its words, else English. */
  const setLanguage = (locale: unknown, messages: unknown): void => {
    state.locale = typeof locale === "string" && /^[a-z]{2,3}$/.test(locale) ? locale : "en";
    state.messages =
      messages !== null && typeof messages === "object" && !Array.isArray(messages)
        ? (messages as Readonly<Record<string, PackMessage>>)
        : undefined;
    // The switcher's labels are in words too: listed again.
    state.listed = "";
    label();
  };

  const say = (text: string): void => {
    // The same sentence again is still news: cleared first.
    announce.textContent = "";
    window.setTimeout(() => (announce.textContent = text), 50);
  };
  const current = (): SessionView | undefined => (state.selected === undefined ? undefined : state.sessions.get(state.selected));
  const labelOf = (view: SessionView, index: number): string => {
    const where = addressOf(view.info.url).host || t("session.numbered", { number: index + 1 });
    return view.info.taskId === state.taskId ? where : t("session.ofAgent", { where, agent: view.info.agent ?? t("session.subAgent") });
  };

  function render(): void {
    const view = current();
    const address = addressOf(view?.info.url);
    host.textContent = address.host;
    path.textContent = address.path;
    title.textContent = view?.info.title ?? "";
    // A session that closed is over; one whose task ended (inactive) is kept, whether or not an `ended` came: a person
    // may still take it, and while they hold it every view says so.
    const kept =
      view !== undefined &&
      view.info.state !== "closed" &&
      (view.ended ?? KEPT_REASON) === KEPT_REASON &&
      (view.info.state === "inactive" || view.ended === KEPT_REASON);
    const held = view?.info.control === "operator";
    const over = view !== undefined && !(kept && held) && (view.ended !== undefined || view.info.state !== "open");
    let chipState: ChipState = "waiting";
    if (view !== undefined) {
      if (over) chipState = "ended";
      // Who acts in the page shows to every watcher, not only the tab in control.
      else if (view.info.control === "operator") chipState = "operator";
      else if (view.info.control === "requested") chipState = "requested";
      else if (view.hidden === "paused") chipState = "paused";
      else if (view.hidden !== undefined) chipState = "hidden";
      else if (view.loading) chipState = "loading";
      else if (view.frame?.source === "live") chipState = "live";
    }
    // The state is the stylesheet's and a test's to read; the words are the reader's, in their language.
    chip.dataset["state"] = chipState;
    chip.textContent = t(`chip.${chipState}`);
    // The outline says who acts: the agent's colour, or the person's while they hold the page.
    stage.dataset["control"] = view === undefined || over ? "none" : (view.info.control ?? "agent");
    const sensitive = view?.hidden !== undefined && view.hidden !== "paused";
    // A sensitive page's last picture is not kept on screen either.
    const showFrame = view?.frame !== undefined && !sensitive;
    image.hidden = !showFrame;
    if (!showFrame) box.hidden = true;
    // The site's letter stands in for a missing picture — never over a notice, and never a digit of an address (127.0.0.1's "1").
    const initial = (address.host.replace(/^www\./, "")[0] ?? "").toUpperCase();
    letter.hidden = showFrame || sensitive || over || !/^\p{L}$/u.test(initial);
    letter.textContent = letter.hidden ? "" : initial;
    notice.hidden = !sensitive && !over;
    notice.textContent =
      sensitive && view?.hidden !== undefined ? hiddenText(view.hidden).notice : over ? (kept ? t("notice.kept") : t("notice.ended")) : "";
    image.alt = view?.info.title ?? (address.host === "" ? t("view.label") : address.host);
    transcript.disabled = (view?.callId ?? view?.info.openedByCallId) === undefined;
    // Expanding is the chat panel's: a tab is already large, and a Command Center tile opens its chat instead.
    expand.hidden = state.slot === "chat.panel.tab" || state.slot === "center.browser";
    const views = [...state.sessions.values()];
    switcher.hidden = views.length < 2;
    if (views.length >= 2) {
      // Rebuilt only when what it lists changes: a rebuild would close a list the reader has open.
      const labels = views.map((entry, index) => [entry.info.sessionId, labelOf(entry, index)] as const);
      const listed = JSON.stringify(labels);
      if (listed !== state.listed) {
        state.listed = listed;
        select.replaceChildren(
          ...labels.map(([value, label]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            return option;
          }),
        );
      }
      if (state.selected !== undefined && select.value !== state.selected) select.value = state.selected;
    }
  }

  /** Shows `frame` (when it is the selected session's), then gives the credit back. */
  function show(frame: BrowserLiveFrame, seq: number): void {
    state.showing = state.showing.then(async () => {
      const view = state.sessions.get(frame.sessionId);
      if (view !== undefined && frame.sessionId === state.selected && view.hidden === undefined) {
        const src = `data:${frame.mime};base64,${frame.data}`;
        // Best effort: a frame that cannot be decoded is skipped; the next one draws.
        await decode(src).catch(() => undefined);
        // A newer state may have arrived while it decoded.
        if (frame.sessionId === state.selected && view.hidden === undefined && view.frame === frame) {
          image.src = src;
          // Acting on an element may scroll it into view: the box follows, with the picture under it.
          if (!box.hidden && state.boxRect !== undefined) positionBox(view, state.boxRect);
        }
        render();
      }
      send({ abi: ABI, type: "ack", seq });
    });
  }

  /** Puts the box over `view`'s frame; `undefined` when there is no frame to place it on. */
  function positionBox(
    view: SessionView,
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  ): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | undefined {
    const metadata = view.frame?.metadata;
    if (metadata === undefined || metadata.deviceWidth <= 0) return undefined;
    // The box is in the document's CSS pixels; the image is the visual viewport, scrolled as the frame says, scaled to the stage.
    const scale = (stage.clientWidth || image.clientWidth) / metadata.deviceWidth;
    const zoom = metadata.pageScaleFactor;
    const left = (rect.x - metadata.scrollOffsetX) * zoom * scale;
    const top = ((rect.y - metadata.scrollOffsetY) * zoom + metadata.offsetTop) * scale;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${rect.width * zoom * scale}px`;
    box.style.height = `${rect.height * zoom * scale}px`;
    return { left, top, width: rect.width * zoom * scale, height: rect.height * zoom * scale };
  }

  function placeBox(
    view: SessionView,
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
    click: boolean,
  ): void {
    const placed = positionBox(view, rect);
    if (placed === undefined) return;
    state.boxRect = rect;
    box.hidden = false;
    // A new action's box is not hidden by the last one's timer.
    if (state.boxTimer !== undefined) window.clearTimeout(state.boxTimer);
    state.boxTimer = undefined;
    if (click && !state.reducedMotion) {
      pulse.hidden = false;
      pulse.style.left = `${placed.left + placed.width / 2}px`;
      pulse.style.top = `${placed.top + placed.height / 2}px`;
      // Restarted for each click.
      pulse.style.animation = "none";
      void pulse.offsetWidth;
      pulse.style.animation = "";
    }
  }

  function receive(seq: number, message: BrowserLiveMessage): void {
    const ensure = (sessionId: string): SessionView => {
      let view = state.sessions.get(sessionId);
      if (view === undefined) {
        view = {
          info: { sessionId, taskId: state.taskId ?? "", state: "open" },
          frame: undefined,
          hidden: undefined,
          ended: undefined,
          loading: false,
          callId: undefined,
        };
        state.sessions.set(sessionId, view);
      }
      state.selected ??= sessionId;
      return view;
    };
    switch (message.kind) {
      case "session": {
        const { kind: _kind, ...info } = message;
        const view = ensure(message.sessionId);
        view.info = info;
        if (info.state === "open") view.ended = undefined;
        break;
      }
      case "navigated": {
        const view = ensure(message.sessionId);
        // The last page's title does not carry over to one without its own.
        const { title: _previous, ...rest } = view.info;
        view.info = { ...rest, url: message.url, ...(message.title === undefined ? {} : { title: message.title }) };
        if (message.sessionId === state.selected) {
          const where = addressOf(message.url);
          const shown = `${where.host}${where.path}`;
          say(
            message.title === undefined
              ? t("say.navigated", { address: shown })
              : t("say.navigatedTitled", { address: shown, title: message.title }),
          );
        }
        break;
      }
      case "action": {
        const view = ensure(message.sessionId);
        if (message.callId !== undefined) view.callId = message.callId;
        if (message.action === "navigate") view.loading = message.phase === "started";
        if (message.sessionId === state.selected) {
          // Waiting for the operator's approval: outlined, and held until it runs or is denied.
          box.classList.toggle("pending", message.phase === "pending");
          if (message.phase === "pending" && message.box !== undefined) {
            placeBox(view, message.box, false);
            // A pack may say each action whole (`say.pending.<action>`); English names it in one sentence.
            const own = `say.pending.${message.action}`;
            say(
              state.messages !== undefined && Object.hasOwn(state.messages, own)
                ? wordsOf(state.messages, own, ENGLISH["say.pending"], { action: message.action })
                : t("say.pending", { action: message.action }),
            );
          }
          if (message.phase === "started" && message.box !== undefined) placeBox(view, message.box, message.action === "click");
          if (message.phase === "ended") {
            if (state.boxTimer !== undefined) window.clearTimeout(state.boxTimer);
            state.boxTimer = window.setTimeout(() => {
              state.boxTimer = undefined;
              box.hidden = true;
            }, 600);
          }
        }
        break;
      }
      case "frame": {
        const view = ensure(message.sessionId);
        view.frame = message;
        if (message.source === "live") view.hidden = undefined;
        show(message, seq);
        return;
      }
      case "control": {
        // Told to every watcher when control changes hands; the session's info said it when the watch began.
        const view = ensure(message.sessionId);
        const { control: _was, ...info } = view.info;
        view.info = message.state === "agent" ? info : { ...info, control: message.state };
        break;
      }
      case "hidden": {
        const view = ensure(message.sessionId);
        const was = view.hidden;
        view.hidden = message.reason;
        if (was !== message.reason && message.sessionId === state.selected)
          say(message.reason === "paused" ? t("say.paused") : hiddenText(message.reason).said);
        break;
      }
      case "ended": {
        const view = ensure(message.sessionId);
        view.ended = message.reason;
        view.loading = false;
        if (message.sessionId === state.selected) say(message.reason === KEPT_REASON ? t("notice.kept") : t("say.ended"));
        break;
      }
    }
    render();
  }

  /** The width the frames were last asked for: asked again when the view is drawn much wider or narrower. */
  let watchedWidth = 0;
  function watch(): void {
    if (!state.live) return;
    const width = Math.min(
      MAX_WIDTH,
      Math.max(160, Math.round((stage.clientWidth || window.innerWidth || 640) * (window.devicePixelRatio || 1))),
    );
    // A change of a few pixels is not worth new frames; an expanded view is.
    if (watchedWidth !== 0 && Math.abs(width - watchedWidth) < WATCH_STEP_PX) return;
    watchedWidth = width;
    send({ abi: ABI, type: "watch", channel: "browser.live", maxWidth: width });
  }
  // Expanded in place (or the panel resized), the view asks for frames as wide as it is now drawn: never a blurry strip.
  const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => watch());
  resized?.observe(stage);

  const onMessage = (event: MessageEvent): void => {
    if (!env.fromHost(event)) return;
    const data = event.data as { readonly abi?: unknown; readonly type?: unknown } | null;
    if (data === null || typeof data !== "object" || data.abi !== ABI) return;
    const message = data as Record<string, unknown>;
    switch (message["type"]) {
      case "init": {
        const context = message["context"] as { readonly taskId?: string } | undefined;
        state.taskId = context?.taskId;
        state.slot = typeof message["slot"] === "string" ? message["slot"] : undefined;
        state.reducedMotion = message["reducedMotion"] === true;
        state.live = Array.isArray(message["channels"]) && message["channels"].includes("browser.live");
        // An older host sends no language: English, as the page is written.
        setLanguage(message["locale"], message["messages"]);
        applyTheme(message["theme"]);
        render();
        watch();
        return;
      }
      case "theme":
        applyTheme(message["theme"]);
        return;
      case "locale":
        setLanguage(message["locale"], message["messages"]);
        render();
        return;
      case "context": {
        const context = message["context"] as { readonly taskId?: string } | undefined;
        state.taskId = context?.taskId;
        state.sessions.clear();
        state.selected = undefined;
        image.removeAttribute("src");
        render();
        return;
      }
      case "channel": {
        if (message["channel"] !== "browser.live" || typeof message["seq"] !== "number") return;
        const live = message["message"] as BrowserLiveMessage | undefined;
        if (live === undefined || typeof live !== "object" || typeof live.kind !== "string") return;
        receive(message["seq"], live);
        return;
      }
      case "size":
        // The frame was given a new size: frames as wide as it is drawn now.
        watch();
        return;
      default:
        // visibility: the host already paces and unwatches.
        return;
    }
  };

  function applyTheme(theme: unknown): void {
    const tokens = (theme as { readonly tokens?: Record<string, unknown> } | undefined)?.tokens;
    if (tokens === undefined) return;
    for (const [name, value] of Object.entries(tokens)) {
      if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string") document.documentElement.style.setProperty(name, value);
    }
    const scheme = (theme as { readonly colorScheme?: unknown }).colorScheme;
    if (scheme === "light" || scheme === "dark") document.documentElement.style.colorScheme = scheme;
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") send({ abi: ABI, type: "shortcut", key: "Escape" });
    else if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.code === "Period" || event.key === ".")) {
      event.preventDefault();
      send({ abi: ABI, type: "shortcut", key: "toggle-panel" });
    }
  };
  const onSelect = (): void => {
    state.selected = select.value;
    const frame = current()?.frame;
    if (frame !== undefined) image.src = `data:${frame.mime};base64,${frame.data}`;
    box.hidden = true;
    render();
  };
  const onTranscript = (): void => {
    const view = current();
    const callId = view?.callId ?? view?.info.openedByCallId;
    if (callId !== undefined) send({ abi: ABI, type: "navigate", target: { to: "tool-call", callId } });
  };
  const onExpand = (): void => send({ abi: ABI, type: "navigate", target: { to: "slot", slot: "chat.panel.tab" } });

  window.addEventListener("message", onMessage);
  window.addEventListener("keydown", onKey);
  select.addEventListener("change", onSelect);
  transcript.addEventListener("click", onTranscript);
  expand.addEventListener("click", onExpand);
  render();
  send({ abi: ABI, type: "ready" });
  return {
    stop() {
      resized?.disconnect();
      if (state.boxTimer !== undefined) window.clearTimeout(state.boxTimer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
      select.removeEventListener("change", onSelect);
      transcript.removeEventListener("click", onTranscript);
      expand.removeEventListener("click", onExpand);
    },
  };
}

// In its frame, the page starts itself; a test starts it with its own environment.
if (typeof window !== "undefined" && window.parent !== window) {
  const start = (): void => {
    startViewer({ window, document, host: window.parent, fromHost: (event) => event.source === window.parent });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
