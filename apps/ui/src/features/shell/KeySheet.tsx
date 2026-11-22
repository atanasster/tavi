import { Fragment, useEffect, useId, useRef } from "react";

import { Modal } from "../../ui/Modal.js";
import { KEY_MAP, matches, type KeyBinding } from "./keys.js";
import { Button } from "../../ui/Button.js";
import { useT } from "../../lib/i18n.js";

/**
 * The `Cmd+/` sheet: what the page binds, and what it only offers.
 * A chord the browser owns is not promised as a key — it is a button here, so
 * it is discoverable without being a promise the page cannot keep.
 */
export function KeySheet({
  onClose,
  onAction,
  labels = {},
}: {
  readonly onClose: () => void;
  readonly onAction: Partial<Record<KeyBinding["action"], () => void>>;
  /** A binding's words where the page says them otherwise ("New side chat" while Home is on). */
  readonly labels?: Partial<Record<KeyBinding["action"], string>>;
}) {
  const t = useT();
  const bound = KEY_MAP.filter((binding) => binding.tier !== "sheet");
  const heading = useId();
  const offered = KEY_MAP.filter((binding) => binding.tier === "sheet").flatMap((binding) => {
    const act = onAction[binding.action];
    return act === undefined ? [] : [{ binding, act }];
  });
  // The native `<dialog>` (`Modal`) makes the page behind it inert, keeps Tab
  // inside, dims it under a backdrop and gives focus back on close. `Esc` is
  // the dialog's own, so it never cancels a turn behind the sheet; the page's
  // chords stand down while it is open, so `Cmd+/` is caught on the dialog —
  // its header's × included — to close it. Focus starts on that ×, so an
  // Enter right after `Cmd+/` does not run the first offered action.
  const sheet = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const dialog = sheet.current?.closest("dialog");
    if (dialog === null || dialog === undefined) return;
    dialog.querySelector<HTMLElement>(".modal-head button")?.focus();
    const help = KEY_MAP.find((binding) => binding.action === "help");
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (help === undefined || !matches(event, help)) return;
      event.preventDefault();
      latestClose.current();
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <Modal title={t("shell.keys.title")} onClose={onClose}>
      <div className="sheet" ref={sheet}>
        <dl className="sheet-keys">
          {bound.map((binding) => (
            <Fragment key={binding.action}>
              <dt>
                <Chord chord={binding.chord} />
              </dt>
              <dd>{t(binding.labelKey)}</dd>
            </Fragment>
          ))}
        </dl>
        {offered.length === 0 ? null : (
          <section className="sheet-offered" aria-labelledby={`${heading}-offered`}>
            <h3 id={`${heading}-offered`}>{t("shell.keys.offered")}</h3>
            <p className="meta-base">{t("shell.keys.offeredWhy")}</p>
            <div className="sheet-offered-actions">
              {offered.map(({ binding, act }) => (
                <Button
                  size="sm"
                  key={binding.action}
                  onClick={() => {
                    act();
                    onClose();
                  }}
                >
                  {labels[binding.action] ?? t(binding.labelKey)}
                </Button>
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
/** A chord as the keys it is pressed with: `Cmd+Alt+1` is three keycaps, read as the chord. */
function Chord({ chord }: { readonly chord: string }) {
  const keys = chord.split(/\+(?=.)/);
  return (
    <span className="chord">
      {keys.map((key, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <span className="visually-hidden">+</span>}
          <kbd>{key}</kbd>
        </Fragment>
      ))}
    </span>
  );
}
