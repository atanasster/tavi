import { useEffect, useId, useState } from "react";

import { DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS, parseNoThumbnailHosts } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { useLoaded } from "../../hooks/use-loaded.js";
import { Confirm } from "../../ui/Confirm.js";
import { browserRecipes, clearBrowserProfile, proposeSiteNote } from "../center/browser-api.js";
import { LoadError } from "./FormParts.js";
import type { SettingActionProps, SettingSectionProps } from "./types.js";
import { workspaceSettingsActions } from "./workspace-api.js";
import { Failure, Notice } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";
import { shortDay } from "../../lib/time.js";

/** The list as the field shows it: comma-separated, `none` for an empty one. */
const hostsText = (hosts: readonly string[]): string => (hosts.length === 0 ? "none" : hosts.join(", "));
/**
 * The agent's browser profile: the cookies, consent choices and sign-ins its
 * browser keeps between sessions, cleared here after a confirmation. Clearing
 * closes the workspace's open browser sessions first.
 */
export function BrowserProfile({ busy, run }: SettingActionProps) {
  const { client, workspaceId } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <h2>Browser profile</h2>
      <p>
        The agent&rsquo;s browser keeps a profile for this workspace: cookies, the choices you made on consent banners, and the sites you
        signed in to when it handed you the browser. Clearing it signs the agent out everywhere and closes its open browser sessions. Or use{" "}
        <Command>tavi browser clear-profile</Command>.
      </p>
      <div className="actions">
        <Button variant="danger-ghost" disabled={busy !== undefined} onClick={() => setConfirming(true)}>
          {busy === "browser-profile" ? "Clearing…" : "Clear browser profile…"}
        </Button>
      </div>
      <SiteRecipes />
      {confirming ? (
        <Confirm
          title="Clear the browser profile?"
          message="Cookies, consent choices and sign-ins are forgotten, and the agent's open browser sessions in this workspace close."
          action="Clear profile"
          onClose={() => setConfirming(false)}
          onConfirm={() =>
            run("browser-profile", async () => {
              const outcome = await clearBrowserProfile(client, workspaceId);
              if (!outcome.ok) return outcome;
              const { closed } = outcome.value;
              return { ok: true, value: `Browser profile cleared${closed === 0 ? "" : `; ${plural(closed, "browser session")} closed`}.` };
            })
          }
        />
      ) : null}
    </>
  );
}
/**
 * The site recipes: the steps that last led
 * to results on each site, which the agent is shown the next time it gets
 * there; each can be forgotten, or saved as a site note of the operator's own
 * (off until it is turned on in a terminal).
 */
/** A recipe step in words, as the agent is shown it: what was done, to which control, with the site's own value. */
function recipeStepText(step: {
  readonly kind: string;
  readonly role?: string | undefined;
  readonly label?: string | undefined;
  readonly value?: string | undefined;
}): string {
  const target =
    step.role === undefined && step.label === undefined
      ? "the page"
      : `${step.role ?? "element"}${step.label === undefined ? "" : ` “${step.label}”`}`;
  return `${step.kind} ${target}${step.value === undefined ? "" : ` (${step.value})`}`;
}
function SiteRecipes() {
  const { workspaceId } = useWorkspace();
  const { client } = useWorkspace();
  const { data, error, reload } = useLoaded(() => browserRecipes(client, workspaceId));
  const [failure, setFailure] = useState<string>();
  const [forgetting, setForgetting] = useState<string>();
  const [saving, setSaving] = useState<string>();
  /** The note a recipe was saved as, by host: shown off, with how to turn it on. */
  const [saved, setSaved] = useState<Readonly<Record<string, { readonly id: string; readonly file: string }>>>({});
  if (error !== undefined) return <LoadError error={error} reload={reload} />;
  if (data === undefined || data.recipes.length === 0) return null;
  const forget = (host: string | true): void => {
    setForgetting(host === true ? "*" : host);
    void browserRecipes(client, workspaceId, host).then((outcome) => {
      setForgetting(undefined);
      setFailure(outcome.ok ? undefined : outcome.message);
      reload();
    });
  };
  const saveAsNote = (host: string): void => {
    setSaving(host);
    void proposeSiteNote(client, workspaceId, host).then((outcome) => {
      setSaving(undefined);
      setFailure(outcome.ok ? undefined : outcome.message);
      if (outcome.ok) setSaved((before) => ({ ...before, [host]: { id: outcome.value.proposed.id, file: outcome.value.proposed.file } }));
    });
  };
  const busy = forgetting !== undefined || saving !== undefined;
  return (
    <>
      <h2>Site recipes</h2>
      <p>
        The steps that last led to results on a site, shown to the agent the next time it gets there; never what was typed. Or use{" "}
        <Command>tavi browser recipes</Command>.
      </p>
      <ul className="site-recipes">
        {data.recipes.map((recipe) => (
          <li key={recipe.host}>
            <strong>{recipe.host}</strong>{" "}
            <span className="muted">
              {recipe.steps.length} step{recipe.steps.length === 1 ? "" : "s"}, used {recipe.uses} time{recipe.uses === 1 ? "" : "s"}, last{" "}
              {shortDay(recipe.updatedAt.slice(0, 10))}
            </span>{" "}
            <Button
              variant="ghost"
              size="sm"
              // The words it shows, then which site's: a name that holds its visible text (WCAG 2.5.3).
              aria-label={`${saving === recipe.host ? "Saving…" : "Save as a site note"}: ${recipe.host}`}
              disabled={busy || saved[recipe.host] !== undefined}
              onClick={() => saveAsNote(recipe.host)}
            >
              {saving === recipe.host ? "Saving…" : "Save as a site note"}
            </Button>{" "}
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => forget(recipe.host)}>
              {forgetting === recipe.host ? "Forgetting…" : "Forget"}
            </Button>
            {saved[recipe.host] === undefined ? null : (
              <Notice role="status">
                Saved as the site note <strong>{saved[recipe.host]?.id}</strong>, <strong>off</strong>: the agent is not shown it yet.
                Review and edit <code>site-notes/{saved[recipe.host]?.file}</code> in Tavi&rsquo;s data directory, then turn it on with{" "}
                <Command>{`tavi browser site-notes --on ${saved[recipe.host]?.id ?? ""}`}</Command> (with <Command>tavi serve</Command>{" "}
                stopped).
              </Notice>
            )}
            <details>
              <summary className="disclosure">Steps</summary>
              <ol>
                {recipe.steps.map((step, index) => (
                  <li key={index}>{recipeStepText(step)}</li>
                ))}
              </ol>
            </details>
          </li>
        ))}
      </ul>
      <div className="actions">
        <Button variant="ghost" disabled={busy} onClick={() => forget(true)}>
          {forgetting === "*" ? "Forgetting…" : "Forget all recipes"}
        </Button>
      </div>
      {failure === undefined ? null : <Failure>{failure}</Failure>}
    </>
  );
}
/**
 * The hosts whose pages never get a browser thumbnail: a comma-separated
 * list (`*.example.com` for a domain and its subdomains), `none` to thumbnail
 * every host, or the shipped defaults again. A page with a password, payment
 * or one-time-code field gets none wherever it is.
 */
export function NoThumbnailHosts({
  answer,
  hosts,
  busy,
  run,
}: SettingSectionProps & {
  /** The list in effect. */
  readonly hosts: readonly string[];
}) {
  const { client, workspaceId } = useWorkspace();
  const [draft, setDraft] = useState(() => hostsText(hosts));
  const [problem, setProblem] = useState<string>();
  const problemId = useId();
  // Each answer shows what is in effect, so after a save the field is the owner's list.
  const shown = hostsText(hosts);
  useEffect(() => setDraft(shown), [shown]);
  const custom = answer.settings.browserNoThumbnailHosts !== undefined;
  return (
    <>
      <h2>Browser thumbnails</h2>
      <p>
        After the agent opens a page, the Command Center&rsquo;s Browser section keeps a small picture of it. Pages on these hosts never get
        one; <code>*.example.com</code> covers a domain and its subdomains, and a page with a password, payment or one-time-code field gets
        none anywhere. Or use <Command>tavi config set browser.noThumbnailHosts</Command>.
      </p>
      <p className="muted">{custom ? "Your list." : `The defaults: ${hostsText(DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS)}.`}</p>
      <form
        className="actions"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseNoThumbnailHosts(draft);
          if ("invalid" in parsed) {
            setProblem(`${parsed.invalid} is not a host or *.domain. List hosts separated by commas, or write none.`);
            return;
          }
          setProblem(undefined);
          void run("thumbnail-hosts", () => workspaceSettingsActions.setNoThumbnailHosts(client, workspaceId, draft, answer.revision));
        }}
      >
        <input
          className="thumbnail-hosts"
          aria-label="hosts without thumbnails"
          aria-describedby={problem === undefined ? undefined : problemId}
          value={draft}
          disabled={busy !== undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(undefined);
          }}
        />
        <Button variant="primary" type="submit" disabled={busy !== undefined || draft.trim() === "" || draft === shown}>
          {busy === "thumbnail-hosts" ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== undefined || !custom}
          onClick={() => {
            setProblem(undefined);
            void run("thumbnail-defaults", () => workspaceSettingsActions.resetNoThumbnailHosts(client, workspaceId, answer.revision));
          }}
        >
          Reset to defaults
        </Button>
      </form>
      {problem === undefined ? null : <Failure id={problemId}>{problem}</Failure>}
    </>
  );
}
