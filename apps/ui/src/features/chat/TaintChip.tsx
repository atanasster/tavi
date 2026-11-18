import {
  SOURCE_WORDS,
  TAINT_DETAIL_HEAD,
  TAINT_DETAIL_NOTES,
  TAINT_REMEDY,
  provenanceChips,
  taintChipText,
  type LabelSummary,
} from "@tavi/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";

import { loadTaskLabel } from "./tasks-api.js";
import { Button } from "../../ui/Button.js";
import { Icon } from "../../ui/Icon.js";
import { Popover } from "../../ui/Popover.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * The chat header's taint chip (UNTRUSTED-CONTENT U4): once a chat has read
 * content Tavi does not trust, the header says so — up to three sources, each
 * as Tavi established it (the host it parsed, the verified sender domain, the
 * kind) — and its details say what that changes, the remedy (**Start a fresh
 * chat**, WORKING-FOLDERS.md §Taint), and that *Fresh context* does not clear
 * it. Read with `tasks { action: "label" }` — the narrowest read: the label
 * alone — again whenever `version` changes. A clean chat shows nothing.
 */
export function TaintChip({
  taskId,
  version = "",
  onFreshChat,
}: {
  readonly taskId: string;
  /** What changes when the chat may have read something since (a turn ended): it is read again then. */
  readonly version?: string;
  /** Start a new chat: the remedy. */
  readonly onFreshChat?: (() => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const [data, setData] = useState<LabelSummary>();
  // Read again as each turn ends; set only when what it says changed, so a clean chat's turns draw nothing more.
  useEffect(() => {
    let current = true;
    void loadTaskLabel(client, workspaceId, taskId).then((answer) => {
      if (!current || !answer.ok) return;
      const label = answer.value.contextLabel;
      const tainted = label !== null && label.integrity === "untrusted" ? label : undefined;
      setData((was) => (JSON.stringify(was) === JSON.stringify(tainted) ? was : tainted));
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId, taskId, version]);
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  if (data === undefined) return null;
  return (
    <TaintChipView
      label={data}
      open={open}
      chip={chip}
      onToggle={() => setOpen((was) => !was)}
      onClose={() => {
        setOpen(false);
        chip.current?.focus();
      }}
      onFreshChat={onFreshChat}
    />
  );
}

/** The chip and its details, for a tainted label. */
export function TaintChipView({
  label,
  open,
  chip,
  onToggle,
  onClose,
  onFreshChat,
}: {
  readonly label: LabelSummary;
  readonly open: boolean;
  readonly chip?: RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onFreshChat?: (() => void) | undefined;
}) {
  const text = taintChipText(label);
  const chips = provenanceChips(label);
  return (
    <span className="taint-chip-wrap">
      {/* A shield in the warning colour; what it read is its name and its tooltip, and the panel says the rest. */}
      <Button
        variant="ghost"
        size={["icon", "sm"]}
        className="taint-chip"
        ref={chip}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Untrusted content: ${text}`}
        title={`${text}: this chat read content Tavi does not trust`}
        onClick={onToggle}
      >
        <Icon name="shield-alert" size="sm" />
      </Button>
      {open ? (
        <Popover
          className={chip === undefined ? "taint-panel" : "taint-panel taint-panel-anchored"}
          label="What this chat read"
          // By its chip, its right edge on the chip's and kept inside the window: the chip sits near the header's end.
          {...(chip === undefined ? {} : { anchor: chip, anchoring: { placement: "bottom", align: "end" } as const })}
          onClose={() => onClose()}
        >
          <p>{TAINT_DETAIL_HEAD}</p>
          <ul className="source-chips list-reset">
            {chips.length === 0 ? (
              <li className="source-chip">
                <span className="source-established">{SOURCE_WORDS["unknown-source"]}</span>
              </li>
            ) : null}
            {chips.map((source) => (
              <li key={source.established} className="source-chip">
                <span className="source-established">{source.established}</span>
                {source.claim === undefined ? null : <span className="source-claim"> — {source.claim}</span>}
              </li>
            ))}
          </ul>
          {TAINT_DETAIL_NOTES.map((line) => (
            <p key={line} className="meta-sm">
              {line}
            </p>
          ))}
          <div className="actions">
            {onFreshChat === undefined ? null : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  onClose();
                  onFreshChat();
                }}
              >
                {TAINT_REMEDY}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </Popover>
      ) : null}
    </span>
  );
}
