// The smallest browser view a plugin can be:
// it says it is ready, asks for the one channel its manifest declares, shows
// one session's frames, gives each frame's credit back once it is handled,
// takes the canvas's theme tokens (plugin-base.css has them until then),
// and speaks the canvas's language with the words the host hands it.
// It never sees the canvas, the network or a control: only what the host sends.
const ABI = "tavi.ui/1";
const status = document.querySelector("[data-status]");
const frame = document.querySelector("[data-frame]");
const send = (message) => parent.postMessage({ abi: ABI, ...message }, "*");
/** Kinds of what arrived (the latest 200), kept on the page for anyone looking: a test reads them. */
const seen = [];
/** The session shown: the one the host's context names, else the first that speaks. */
let shown;
/** The newest frame asked to be drawn: an older one finishing later is not. */
let drawing = 0;

/** The page's words in English, as live.html is written: the host's `messages` say them in the canvas's language. */
const ENGLISH = {
  "view.title": "Browser (minimal)",
  "status.waiting": "Waiting for the agent's browser…",
  "status.paused": "Paused: too many browsers are shown at once.",
  "status.hidden": "Hidden: a sensitive page.",
  "status.ended": "The browser session ended.",
  "frame.alt": "The agent's page",
};
/** This plugin's messages in the canvas's language (locales/<lang>.json), from `init` and `locale`; none means English. */
let messages;
/** What the status line says: a message's key, or an address, which is never translated. */
let statusSaid = { key: "status.waiting" };

/** `key`'s words: the pack's when it has them (a plural says its `other`: nothing here is counted), else English. */
const t = (key) => {
  const found = messages !== undefined && Object.hasOwn(messages, key) ? messages[key] : undefined;
  return typeof found === "string" ? found : typeof found?.other === "string" ? found.other : ENGLISH[key];
};

/** Says the status line again, in the language now set. */
function showStatus(said) {
  statusSaid = said;
  status.textContent = said.key === undefined ? said.text : t(said.key);
}

/** The language `init` or `locale` names, and its words: the page's own words said again in it. */
function setLanguage(locale, words) {
  document.documentElement.lang = typeof locale === "string" && /^[a-z]{2,3}$/.test(locale) ? locale : "en";
  messages = words !== null && typeof words === "object" && !Array.isArray(words) ? words : undefined;
  document.title = t("view.title");
  frame.alt = t("frame.alt");
  showStatus(statusSaid);
}

const note = (kind) => {
  seen.push(kind);
  if (seen.length > 200) seen.shift();
  document.body.dataset.seen = seen.join(" ");
};

/** The canvas's theme: its tokens on the root, over plugin-base.css's, and its scheme. */
function applyTheme(theme) {
  for (const [name, value] of Object.entries(theme?.tokens ?? {})) {
    if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string") document.documentElement.style.setProperty(name, value);
  }
  if (theme?.colorScheme === "light" || theme?.colorScheme === "dark") document.documentElement.style.colorScheme = theme.colorScheme;
}

/** Decodes a frame on its own, draws it if it is still the newest, and always gives its credit back. */
function draw(live, seq) {
  const ticket = (drawing += 1);
  const image = new Image();
  const done = () => send({ type: "ack", seq });
  image.onload = () => {
    if (ticket === drawing) {
      frame.src = image.src;
      frame.hidden = false;
    }
    done();
  };
  image.onerror = done;
  image.src = `data:${live.mime};base64,${live.data}`;
}

window.addEventListener("message", (event) => {
  // Only the canvas around this frame speaks to it.
  if (event.source !== parent) return;
  const message = event.data;
  if (message === null || typeof message !== "object" || message.abi !== ABI) return;
  note(message.type === "channel" ? `channel:${message.channel}:${message.message.kind}` : message.type);
  if (message.type === "init" || message.type === "theme") applyTheme(message.theme);
  // An older host sends no language: English, as the page is written.
  if (message.type === "init" || message.type === "locale") setLanguage(message.locale, message.messages);
  if (message.type === "locale") return;
  if (message.type === "init" || message.type === "context") {
    const context = message.context;
    if (context?.sessionId !== undefined && context.sessionId !== shown) {
      shown = context.sessionId;
      frame.hidden = true;
    }
    if (message.type === "init") send({ type: "watch", channel: "browser.live" });
    return;
  }
  if (message.type !== "channel" || message.channel !== "browser.live") return;
  const live = message.message;
  shown ??= live.sessionId;
  // Another session's (a sub-agent's): its credit goes back, nothing is drawn.
  if (live.sessionId !== shown) {
    if (live.kind === "frame") send({ type: "ack", seq: message.seq });
    return;
  }
  if (live.kind === "frame") draw(live, message.seq);
  else if (live.kind === "navigated" || (live.kind === "session" && live.url !== undefined)) {
    showStatus({ text: live.title === undefined ? live.url : `${live.title} — ${live.url}` });
  } else if (live.kind === "hidden") {
    frame.hidden = true;
    showStatus({ key: live.reason === "paused" ? "status.paused" : "status.hidden" });
  } else if (live.kind === "ended") {
    showStatus({ key: "status.ended" });
  }
});

send({ type: "ready" });
