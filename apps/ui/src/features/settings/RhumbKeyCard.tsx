import { useState } from "react";

import { Button } from "../../ui/Button.js";
import { Card } from "../../ui/Card.js";
import { RHUMB_SIGN_UP_URL } from "./lifecycle-api.js";
import { PasswordInput } from "./PasswordInput.js";

/**
 * Model retirements: with a Rhumb key the owner checks daily whether a model
 * Tavi uses retires, is redirected or changes price, and never changes one.
 * Without one, where to get a key and a field to store it.
 */
export function RhumbKeyCard({
  stored,
  busy,
  onStore,
  onCheck,
}: {
  /** Whether the credential store holds `rhumb`; `undefined` while that is read. */
  readonly stored: boolean | undefined;
  readonly busy: string | undefined;
  readonly onStore: (key: string) => void;
  readonly onCheck: () => void;
}) {
  const [key, setKey] = useState("");
  if (stored === undefined) return null;
  return (
    <Card
      title="Model retirements"
      titleId="rhumb-title"
      level={2}
      actions={
        stored ? (
          <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={onCheck}>
            {busy === "lifecycle-sync" ? "Checking…" : "Check now"}
          </Button>
        ) : null
      }
    >
      {stored ? (
        <p className="muted">
          A Rhumb key is stored. Tavi checks daily which models it uses retire, are redirected or change price, and says so here and in{" "}
          <code>tavi doctor</code>. It never changes a model for you.
        </p>
      ) : (
        <form
          className="rhumb-key"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() === "") return;
            // Kept until it is stored: a failed store leaves it to retry, and a stored one replaces the form.
            onStore(key);
          }}
        >
          <p className="muted">
            Providers retire models, sometimes with weeks' notice. With a free key from{" "}
            <a href={RHUMB_SIGN_UP_URL} target="_blank" rel="noreferrer">
              Rhumb
            </a>
            , Tavi checks daily and says before one you use goes. Only provider names are sent, never which models you use.
          </p>
          <label htmlFor="rhumb-key">Rhumb key</label>
          <PasswordInput id="rhumb-key" value={key} placeholder="Paste the key" invalid={false} onChange={setKey} />
          <Button type="submit" variant="primary" size="sm" disabled={busy !== undefined || key.trim() === ""}>
            {busy === "rhumb-key" ? "Storing…" : "Store key"}
          </Button>
        </form>
      )}
    </Card>
  );
}
