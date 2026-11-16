import type { ReactNode } from "react";
import { Button } from "../../ui/Button.js";

/** One row of a chat-panel list: a button when it opens something (`onOpen`), a plain line otherwise. */
export function ChatPanelItem({ onOpen, children }: { readonly onOpen?: (() => void) | undefined; readonly children: ReactNode }) {
  return onOpen === undefined ? (
    <div className="chat-panel-item">{children}</div>
  ) : (
    <Button variant="bare" className="chat-panel-item" onClick={onOpen}>
      {children}
    </Button>
  );
}
