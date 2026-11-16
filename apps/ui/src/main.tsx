// First: before any schema parses (see the module).
import "./lib/jitless.js";

import { adoptStyleNonce } from "./lib/csp-nonce.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { connectThroughBridge } from "@tavi/client/browser";

import { App } from "./App.js";
import { createCanvasStore } from "./features/chat/store/store.js";
import type { RememberedTask, TaskMemory } from "./features/chat/store/types.js";
import type { PageNavigation } from "./features/shell/route.js";
import { startPage } from "./features/startup/start.js";
import { readStoredJson, writeStoredJson } from "./lib/storage.js";
import { ViewBoundary } from "./ui/ViewBoundary.js";
import "./styles/index.css";

/**
 * The canvas acts in workspace `default` as principal `operator`, as `tavi
 * chat` does by default; `tavi ui` has no flag for either yet.
 */
const WORKSPACE = "default";
const PRINCIPAL = "operator";

/** The tab's own storage, when the browser lets the page have it. */
const tabStorage = ((): Storage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
})();

/** The page's last task, kept in the tab's storage so a reload continues it. */
const TASK_KEY = "tavi.task";
const memory: TaskMemory = {
  load: () => {
    const parsed = readStoredJson(TASK_KEY, "session") as Partial<RememberedTask> | null | undefined;
    return typeof parsed?.taskId === "string" && typeof parsed.conversationId === "string"
      ? { taskId: parsed.taskId, conversationId: parsed.conversationId }
      : undefined;
  },
  save: (task) => writeStoredJson(TASK_KEY, task, "session"),
};

/** The address bar, as `route.ts` reads and writes it. */
const navigation: PageNavigation = {
  location: window.location,
  history: {
    pushState: (data, unused, url) => window.history.pushState(data, unused, url),
    replaceState: (data, unused, url) => window.history.replaceState(data, unused, url),
  },
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  removeEventListener: (type, listener) => window.removeEventListener(type, listener),
};

// Before anything renders: a select's scroll lock injects its style with this nonce.
adoptStyleNonce();

const root = document.getElementById("root");
if (root !== null) {
  const view = createRoot(root);
  void startPage({
    ...(tabStorage === undefined ? {} : { storage: tabStorage }),
    location: window.location,
    history: window.history,
    fetch: (url, init) => window.fetch(url, init),
    connect: (secret) => connectThroughBridge({ origin: window.location.origin, secret }),
    message: (text) =>
      view.render(
        <main className="message">
          <p>{text}</p>
        </main>,
      ),
    render: (client) =>
      view.render(
        <StrictMode>
          <ViewBoundary resetKey="canvas" what="canvas">
            <App
              store={createCanvasStore(client, {
                workspaceId: WORKSPACE,
                principal: PRINCIPAL,
                mintKey: () => `ui-${crypto.randomUUID()}`,
                memory,
              })}
              client={client}
              workspaceId={WORKSPACE}
              principal={PRINCIPAL}
              navigation={navigation}
            />
          </ViewBoundary>
        </StrictMode>,
      ),
  });
}
