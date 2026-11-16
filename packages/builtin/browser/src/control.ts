import type { BrowserLiveInputEvent, BrowserLivePhoneViewport } from "@tavi/contracts";
import type { BrowserContext, CDPSession, Dialog, ElementHandle, FileChooser, Page } from "playwright";

import type { LiveControlTarget, LiveDialogInfo, LiveSelectInfo } from "./live.js";
import type { PageGlobals } from "./page-globals.js";

/**
 * Operator takeover over a Playwright session: forwarded input through the DevTools `Input` domain, and the
 * native popups a screencast cannot show — `<select>` lists, JavaScript
 * dialogs, file choosers — routed to the host instead.
 *
 * Input is applied and dropped: nothing here keeps an event or logs one.
 */

/** The session a person takes over: its context, the page it shows now, and how a page they open becomes that page. */
export interface ControlledSession {
  readonly context: BrowserContext;
  page(): Page;
  follow(popup: Page): Promise<void>;
  /** Whether a tab the context opened is this session's: in a profile other sessions share, theirs are not. Absent, every one is. */
  owns?(popup: Page): Promise<boolean>;
  /** The pages whose dialogs the person answers now: held while the takeover binds them, so nothing else answers those. */
  readonly heldDialogPages?: Set<Page>;
}

/** How long one input event may take: a page stuck in a dialog does not hold the queue. */
const INPUT_TIMEOUT_MS = 5_000;
const DIALOG_TEXT_MAX = 1000;

/** The DOM a `<select>` exposes, duck-typed: this package has no DOM types. */
interface SelectLike {
  readonly tagName: string;
  readonly disabled: boolean;
  readonly multiple: boolean;
  readonly size: number;
  readonly options: ArrayLike<{
    readonly value: string;
    readonly label: string;
    readonly text: string;
    readonly selected: boolean;
    readonly disabled: boolean;
  }>;
  getBoundingClientRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** Runs in the page: the drop-down `<select>` under a point, or `null`. A list box (`multiple`, `size` > 1) draws in the page itself. */
function selectAtPoint(point: { readonly x: number; readonly y: number }): SelectLike | null {
  const document = (
    globalThis as PageGlobals<{ elementFromPoint(x: number, y: number): { closest(selector: string): SelectLike | null } | null }>
  ).document;
  const select = document?.elementFromPoint(point.x, point.y)?.closest("select") ?? null;
  return select !== null && !select.disabled && !select.multiple && select.size <= 1 ? select : null;
}

/** Runs in the page: a `<select>`'s options and box. */
function pickerOf(select: SelectLike): Omit<LiveSelectInfo, "ref"> {
  const box = select.getBoundingClientRect();
  return {
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    options: Array.from(select.options)
      .slice(0, 500)
      .map((option) => ({
        value: option.value,
        label: (option.label || option.text).trim(),
        selected: option.selected,
        ...(option.disabled ? { disabled: true } : {}),
      })),
  };
}

async function timed<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the page did not take the input in time")), INPUT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The DevTools mouse event an input event stands for. */
function mouseEvent(event: Extract<BrowserLiveInputEvent, { type: "mouse" | "wheel" }>): Record<string, unknown> {
  if (event.type === "wheel")
    return { type: "mouseWheel", x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.modifiers ?? 0 };
  const moving = event.action === "move";
  return {
    type: moving ? "mouseMoved" : event.action === "down" ? "mousePressed" : "mouseReleased",
    x: event.x,
    y: event.y,
    button: event.button ?? (moving ? "none" : "left"),
    clickCount: event.clickCount ?? (moving ? 0 : 1),
    modifiers: event.modifiers ?? 0,
  };
}

/** The DevTools key event: `keyDown` with the character for a printable key, `rawKeyDown` otherwise — never a `char` event. */
function keyEvent(event: Extract<BrowserLiveInputEvent, { type: "key" }>): Record<string, unknown> {
  const printable = event.action === "down" && event.text !== undefined && event.text !== "";
  return {
    type: event.action === "up" ? "keyUp" : printable ? "keyDown" : "rawKeyDown",
    key: event.key,
    code: event.code,
    modifiers: event.modifiers ?? 0,
    ...(event.keyCode === undefined ? {} : { windowsVirtualKeyCode: event.keyCode, nativeVirtualKeyCode: event.keyCode }),
    ...(printable ? { text: event.text, unmodifiedText: event.text } : {}),
  };
}

export function playwrightControlTarget(session: ControlledSession): LiveControlTarget {
  let cdp: { readonly page: Page; readonly client: CDPSession } | undefined;
  /** Between `begin` and its undoing: no DevTools session is opened outside it. */
  let active = false;
  /** Opening and closing DevTools sessions one at a time, so none is left behind. */
  let lock: Promise<unknown> = Promise.resolve();
  let dialog: Dialog | undefined;
  /** The page's open file chooser, waiting for the person's files. */
  let chooser: FileChooser | undefined;
  const pickers = new Map<string, ElementHandle>();
  let pickerCount = 0;
  /** A phone's take: the size the shown page is laid out at, while it holds the page. */
  let phone: BrowserLivePhoneViewport | undefined;
  /** Each page laid out at the phone's size, with its own size to go back to. */
  const ownSizes = new Map<Page, { readonly width: number; readonly height: number }>();

  /**
   * Until `page` has painted at its new size: a screencast started sooner sends a first frame of the old size, which a
   * still page never replaces. Bounded, as a page stuck in a dialog paints nothing.
   */
  async function painted(page: Page): Promise<void> {
    await timed(
      page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const page = globalThis as { requestAnimationFrame?(callback: () => void): number };
            if (page.requestAnimationFrame === undefined) return resolve();
            page.requestAnimationFrame(() => page.requestAnimationFrame?.(() => resolve()));
          }),
      ),
    ).catch(() => undefined);
  }

  /**
   * Lays the page shown now out at the phone's size; a page with no fixed size of its own is left as it is (it could
   * not be put back). Through the takeover's own DevTools session, not Playwright's viewport: in the full Chromium's
   * headless mode that also resizes the window, which cannot be narrower than 500 px, and the screencast then shows
   * the window, not the page.
   */
  async function fit(page: Page): Promise<void> {
    if (phone === undefined || page.isClosed() || page !== session.page()) return;
    const own = ownSizes.get(page) ?? page.viewportSize();
    if (own === null) return;
    ownSizes.set(page, own);
    const devtools = await client();
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: phone.width,
      height: phone.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await painted(page);
  }

  /**
   * Puts every page the phone's take laid out back at its own size: the override dropped, and Playwright's own viewport
   * sent again (changed and back, as it sends nothing for a size it believes is set).
   */
  async function restoreSizes(): Promise<void> {
    const resized = [...ownSizes];
    ownSizes.clear();
    if (resized.length === 0) return;
    // Best effort: a page already closed has no size to restore.
    await cdp?.client.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
    await Promise.all(
      resized.map(async ([page, own]) => {
        if (page.isClosed()) return;
        await page.setViewportSize({ width: own.width, height: own.height + 1 }).catch(() => undefined);
        await page.setViewportSize(own).catch(() => undefined);
        await painted(page);
      }),
    );
  }

  /** A DevTools session on the page shown now, with focus emulation on: a background tab still shows its caret and focus. */
  function client(): Promise<CDPSession> {
    const next = lock.then(open);
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    lock = next.catch(() => undefined);
    return next;
  }

  async function open(): Promise<CDPSession> {
    if (!active) throw new Error("the takeover has ended");
    const page = session.page();
    if (cdp?.page === page) return cdp.client;
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await cdp?.client.detach().catch(() => undefined);
    const fresh = await session.context.newCDPSession(page);
    cdp = { page, client: fresh };
    await fresh.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return fresh;
  }

  async function forgetPickers(): Promise<void> {
    const handles = [...pickers.values()];
    pickers.clear();
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
  }

  return {
    async begin(events) {
      const bound = new Set<Page>();
      const onDialog = (opened: Dialog): void => {
        dialog = opened;
        const type = opened.type();
        const info: LiveDialogInfo = {
          type: type === "confirm" || type === "prompt" || type === "beforeunload" ? type : "alert",
          message: opened.message().slice(0, DIALOG_TEXT_MAX),
          ...(type === "prompt" ? { defaultValue: opened.defaultValue().slice(0, DIALOG_TEXT_MAX) } : {}),
        };
        events.dialog(info);
      };
      // Listening is what keeps the native chooser from opening: the host offers its own picker.
      const onChooser = (opened: FileChooser): void => {
        chooser = opened;
        // No accept attribute read: the chooser offers every file type.
        void opened
          .element()
          .getAttribute("accept")
          .catch(() => null)
          .then((accept) => {
            if (chooser !== opened) return;
            events.fileChooser({ multiple: opened.isMultiple(), ...(accept === null || accept === "" ? {} : { accept }) });
          });
      };
      const bind = (page: Page): void => {
        if (bound.has(page)) return;
        bound.add(page);
        session.heldDialogPages?.add(page);
        page.on("dialog", onDialog);
        page.on("filechooser", onChooser);
      };
      const onPage = (popup: Page): void => {
        void (session.owns?.(popup) ?? Promise.resolve(true))
          .then(async (own) => {
            if (!own || !active) return;
            bind(popup);
            await session.follow(popup);
            await fit(popup);
            await client();
          })
          // Best effort: a popup that cannot be followed stays unfollowed; the session's own page goes on.
          .catch(() => undefined);
      };
      active = true;
      bind(session.page());
      session.context.on("page", onPage);
      try {
        await client();
      } catch (error) {
        active = false;
        session.context.off("page", onPage);
        for (const page of bound) {
          page.off("dialog", onDialog);
          page.off("filechooser", onChooser);
          session.heldDialogPages?.delete(page);
        }
        throw error;
      }
      return async () => {
        active = false;
        session.context.off("page", onPage);
        for (const page of bound) {
          page.off("dialog", onDialog);
          page.off("filechooser", onChooser);
          session.heldDialogPages?.delete(page);
        }
        // Unanswered, a dialog is dismissed, as Playwright does with no listener; a file chooser gets no file.
        await dialog?.dismiss().catch(() => undefined);
        dialog = undefined;
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await chooser?.setFiles([]).catch(() => undefined);
        chooser = undefined;
        await forgetPickers();
        phone = undefined;
        await restoreSizes();
        // One still opening finishes first, then is closed with the rest.
        await lock;
        const ending = cdp;
        cdp = undefined;
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await ending?.client.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await ending?.client.detach().catch(() => undefined);
      };
    },

    async layout(viewport) {
      if (!active) return;
      phone = viewport;
      if (viewport === undefined) await restoreSizes();
      else await fit(session.page());
    },

    async input(event) {
      const devtools = await client();
      if (event.type === "mouse" || event.type === "wheel")
        await timed(devtools.send("Input.dispatchMouseEvent", mouseEvent(event) as never));
      else if (event.type === "key") await timed(devtools.send("Input.dispatchKeyEvent", keyEvent(event) as never));
      else await timed(devtools.send("Input.insertText", { text: event.text }));
    },

    async selectAt(x, y) {
      // Bounded like input: a page busy in a long script does not hold the queue.
      const handle = await timed(session.page().evaluateHandle(selectAtPoint, { x, y }));
      const element: ElementHandle | null = handle.asElement();
      if (element === null) {
        await handle.dispose();
        return undefined;
      }
      // Passed whole: it runs in the page, so it uses nothing from this module.
      const picker = await timed(element.evaluate(pickerOf)).catch(async (error: unknown) => {
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await element.dispose().catch(() => undefined);
        throw error;
      });
      await forgetPickers();
      const ref = `select-${(pickerCount += 1)}`;
      pickers.set(ref, element);
      return { ref, ...picker };
    },

    async selectOption(ref, value) {
      const element = pickers.get(ref);
      if (element === undefined) throw new Error("that list is no longer open");
      pickers.delete(ref);
      try {
        await element.selectOption({ value });
      } finally {
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await element.dispose().catch(() => undefined);
      }
    },

    async setFiles(files) {
      const open = chooser;
      chooser = undefined;
      if (open === undefined) throw new Error("the page's file chooser is no longer open");
      // A view over the caller's bytes, not a copy: the live view zeroes them once they are handed over.
      await open.setFiles(
        files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.buffer.buffer, file.buffer.byteOffset, file.buffer.byteLength),
        })),
      );
    },

    async dismissChooser() {
      const open = chooser;
      chooser = undefined;
      await open?.setFiles([]);
    },

    async answerDialog(accept, text) {
      const open = dialog;
      dialog = undefined;
      if (open === undefined) return;
      if (accept) await open.accept(text);
      else await open.dismiss();
    },
  };
}
