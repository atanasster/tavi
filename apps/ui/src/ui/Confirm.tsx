import { useId, useState, type ReactNode } from "react";

import { Modal } from "./Modal.js";
import { Button } from "./Button.js";

/** Ask before an action that cannot be undone, saying what it breaks. */
export function Confirm({
  title,
  message,
  action,
  onConfirm,
  onClose,
  children,
}: {
  readonly title: string;
  readonly message: string;
  /** A choice the confirm also asks, under its message. */
  readonly children?: ReactNode;
  readonly action: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const [working, setWorking] = useState(false);
  const messageId = useId();
  return (
    <Modal title={title} busy={working} describedBy={messageId} onClose={onClose}>
      <p id={messageId}>{message}</p>
      {children}
      <div className="actions">
        <Button variant="ghost" disabled={working} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={working}
          onClick={() => {
            setWorking(true);
            void onConfirm().then(onClose);
          }}
        >
          {action}
        </Button>
      </div>
    </Modal>
  );
}
