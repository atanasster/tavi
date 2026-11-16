import { Fragment, useId, useState } from "react";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { appsPath } from "../shell/route.js";
import {
  mcpActions,
  type McpDiscoverPage,
  type McpRegistryEntry,
  type McpReview,
  type McpReviewTool,
  type McpToolChoice,
} from "./plugins-api.js";
import { BusyFieldset, Failure, LoadState, Notice } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { Modal } from "../../ui/Modal.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * An MCP server's own pieces, which Connected apps embeds: adding one by
 * its address or npm package, the MCP Registry search, the review of every tool with its marks and what each may
 * do, and its log. The owner decides every rule: a page cannot weaken a server's sandbox or turn MCP on
 * (`tavi mcp` can).
 */

const EFFECTS = ["read-only", "mutating", "external"] as const;
const FLOORS = ["low", "medium", "high", "critical"] as const;

/**
 * Where a Center notice links: Connected apps with `?review=<id>`, which opens that server's app and its review.
 * A query, not a hash: the canvas reads its URL's hash as a sign-in link.
 */
export const mcpReviewPath = (pluginId: string): string => `${appsPath()}?review=${encodeURIComponent(pluginId)}`;

/** How the owner ends a warning that a tool overlaps a built-in one; the remedy is each surface's own. */
const OVERLAP = "the model may pick either";

/** A changed tool's definition, field by field: what was approved, and what the server lists now. */
function DefinitionChanges({ changes }: { readonly changes: NonNullable<McpReviewTool["changedFields"]> }) {
  return (
    <details open className="mcp-definition-changes">
      <summary>What changed since it was approved</summary>
      <ul>
        {changes.fields.map((change) => (
          <li key={change.field}>
            <code>{change.field}</code>: <del>{change.before ?? "(none)"}</del> → <ins>{change.after ?? "(none)"}</ins>
          </li>
        ))}
        {changes.more > 0 ? <li className="muted">… and {String(changes.more)} more</li> : null}
      </ul>
    </details>
  );
}

/** Why a tool is flagged: where its definition reads like instructions, by JSON pointer, past its description alone. */
function flaggedMark(at: readonly string[]): string {
  if (at.length === 0 || (at.length === 1 && at[0] === "/description")) return "FLAGGED: its description reads like instructions";
  return `FLAGGED: reads like instructions at ${at.slice(0, 5).join(", ")}${at.length > 5 ? ", …" : ""}`;
}

/** A tool that needs an explicit choice before approval: doubtful or flagged, with nothing decided before. */
export function needsChoice(tool: McpReviewTool): boolean {
  return (tool.doubtful || tool.flagged) && tool.carriedFrom === undefined && (tool.state === "pending" || tool.state === "withheld");
}

/**
 * The effect a tool shows, and approval saves: the person's choice; else, for a tool approved or left out at
 * its current definition, its decision; else nothing for one that needs a choice, or its suggestion. A changed
 * (withheld) tool shows its suggestion, not its old decision, which no longer applies.
 */
function shownEffect(tool: McpReviewTool, choice: McpToolChoice = {}): McpToolChoice["effect"] {
  if (choice.effect !== undefined) return choice.effect;
  if ((tool.state === "approved" || tool.state === "disabled") && tool.decision !== undefined) return tool.decision.effect;
  return needsChoice(tool) ? undefined : tool.suggestedEffect;
}

/** The floor a tool shows, and approval saves: the person's; else its decision's for that effect; else the suggestion's for it; else low (none). */
function shownFloor(tool: McpReviewTool, choice: McpToolChoice = {}): NonNullable<McpToolChoice["floor"]> {
  if (choice.floor !== undefined) return choice.floor;
  const effect = shownEffect(tool, choice);
  if ((tool.state === "approved" || tool.state === "disabled") && tool.decision !== undefined && effect === tool.decision.effect)
    return tool.decision.minRisk ?? "low";
  return effect === tool.suggestedEffect ? (tool.suggestedMinRisk ?? "low") : "low";
}

/** Whether the review can be approved with `choices`: every tool needing a choice has an effect, or is left out. */
export function approvable(review: McpReview, choices: Readonly<Record<string, McpToolChoice>>): boolean {
  return review.tools
    .filter(needsChoice)
    .every((tool) => choices[tool.name]?.disabled === true || choices[tool.name]?.effect !== undefined);
}

export function AddServerForm({
  busy,
  onAdd,
}: {
  readonly busy: boolean;
  /** Adds it; true when the owner did, so the form clears only then. */
  readonly onAdd: (slug: string, form: Parameters<typeof mcpActions.add>[2]) => Promise<boolean>;
}) {
  const id = useId();
  const [slug, setSlug] = useState("");
  const [source, setSource] = useState<"url" | "npm">("url");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState(false);
  const [lan, setLan] = useState(false);
  const [spec, setSpec] = useState("");
  const submit = (): void => {
    // Tavi's presets are Discover's own cards: this form adds by address or package only.
    const form =
      source === "url"
        ? { kind: "url" as const, url: url.trim(), headers: token ? ["Authorization=Bearer @token"] : [], lan }
        : { kind: "npm" as const, spec: spec.trim() };
    void onAdd(slug.trim(), form).then((added) => {
      if (!added) return;
      setSlug("");
      setUrl("");
      setSpec("");
    });
  };
  return (
    <form
      className="settings-panel"
      aria-label="Add an MCP server"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="settings-section-title">Add a server</h3>
      <BusyFieldset busy={busy} label="Adding the server…" className="settings-fields">
        <label htmlFor={`${id}-slug`}>
          Name
          <input
            id={`${id}-slug`}
            value={slug}
            placeholder="docs"
            pattern="[a-z][a-z0-9]{0,18}"
            required
            onChange={(event) => setSlug(event.target.value)}
          />
        </label>
        <label>
          Server
          <Select aria-label="Server" value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
            <option value="url">Remote (URL)</option>
            <option value="npm">npm package</option>
          </Select>
        </label>
        {source === "url" ? (
          <>
            <label htmlFor={`${id}-url`} className="mcp-add-wide">
              URL
              <input
                id={`${id}-url`}
                value={url}
                placeholder="https://docs.example/mcp"
                required
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label>
              <input type="checkbox" checked={token} onChange={(event) => setToken(event.target.checked)} /> Sends a token (Authorization:
              Bearer)
            </label>
            <label>
              <input type="checkbox" checked={lan} onChange={(event) => setLan(event.target.checked)} /> On my network (a private address,
              plain http there)
            </label>
          </>
        ) : (
          <label htmlFor={`${id}-spec`} className="mcp-add-wide">
            Package
            <input
              id={`${id}-spec`}
              value={spec}
              placeholder="@acme/notes-mcp@2.4.1"
              required
              onChange={(event) => setSpec(event.target.value)}
            />
          </label>
        )}
        <div className="actions">
          <Button variant="primary" type="submit" disabled={slug.trim() === ""}>
            Add server
          </Button>
        </div>
      </BusyFieldset>
    </form>
  );
}

/**
 * Discover: the MCP Registry searched on the owner,
 * each entry with its labels and its ways in. Its words are its publisher's —
 * no listing is a reason to trust a server — and adding one proposes it, to be
 * probed and reviewed like any other.
 */
export function DiscoverPanel({
  busy,
  onAdd,
}: {
  readonly busy: boolean;
  readonly onAdd: (slug: string, form: Parameters<typeof mcpActions.add>[2]) => Promise<boolean>;
}) {
  const { client } = useWorkspace();
  const id = useId();
  const [query, setQuery] = useState("");
  // The page shown, with the words it was searched for: "More" continues that search, whatever the box says now.
  const [page, setPage] = useState<(McpDiscoverPage & { readonly query: string }) | undefined>();
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const search = async (words: string, cursor?: string): Promise<void> => {
    setSearching(true);
    setFailure(undefined);
    const found = await mcpActions.search(client, words, cursor);
    setSearching(false);
    if (!found.ok) {
      setFailure(found.message);
      return;
    }
    const next = { ...found.value.discover, query: words };
    setPage((before) => (cursor === undefined || before === undefined ? next : { ...next, entries: [...before.entries, ...next.entries] }));
  };
  return (
    <details className="settings-panel">
      <summary>Discover servers in the MCP Registry</summary>
      <form
        className="actions mcp-search"
        role="search"
        aria-label="Search the MCP Registry"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query.trim());
        }}
      >
        <input
          id={`${id}-query`}
          aria-label="Search"
          value={query}
          placeholder="notes, calendar, github…"
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </Button>
      </form>
      <p className="muted">
        Listings are their publishers&apos; words, not a reason to trust a server: each one you add is probed in its sandbox and reviewed
        first.
      </p>
      {failure === undefined ? null : <Failure>{failure}</Failure>}
      {page === undefined ? null : page.entries.length === 0 ? (
        <Empty>No server found in {page.registry}.</Empty>
      ) : (
        <ul className="rows" aria-label="Registry results">
          {page.entries.map((entry) => (
            <DiscoverEntry key={`${entry.name}@${entry.version}`} entry={entry} busy={busy} onAdd={onAdd} />
          ))}
        </ul>
      )}
      {page?.next === undefined ? null : (
        <Button disabled={searching} onClick={() => void search(page.query, page.next)}>
          More
        </Button>
      )}
    </details>
  );
}

function DiscoverEntry({
  entry,
  busy,
  onAdd,
}: {
  readonly entry: McpRegistryEntry;
  readonly busy: boolean;
  readonly onAdd: (slug: string, form: Parameters<typeof mcpActions.add>[2]) => Promise<boolean>;
}) {
  const id = useId();
  const [slug, setSlug] = useState(entry.slug);
  return (
    <li className="row">
      <span className="plugin-info">
        <span>
          <strong>{entry.title ?? entry.name}</strong>{" "}
          <span className="muted">
            {entry.name} {entry.version}
          </span>{" "}
          {entry.labels.length === 0 ? (
            <span className="badge">not installable</span>
          ) : (
            entry.labels.map((label) => (
              <span key={label} className="badge">
                {label}
              </span>
            ))
          )}
        </span>
        {entry.description === "" ? null : <span className="muted">{entry.description}</span>}
        {entry.unsupported.map((why) => (
          <span key={why} className="muted">
            Not added: {why}
          </span>
        ))}
      </span>
      {entry.options.length === 0 ? null : (
        <span className="actions">
          <input
            id={`${id}-slug`}
            aria-label="Name"
            className="mcp-slug"
            value={slug}
            pattern="[a-z][a-z0-9]{0,18}"
            required
            onChange={(event) => setSlug(event.target.value)}
          />
          {entry.options.map((option) => (
            <Button
              key={option.key}
              disabled={busy || !/^[a-z][a-z0-9]{0,18}$/.test(slug)}
              title={`${option.summary}${option.settings.length + option.credentials.length === 0 ? "" : `; then set ${[...option.settings, ...option.credentials].join(", ")}`}`}
              aria-label={`Add ${entry.name} as ${option.kind === "remote" ? "a remote server" : `its ${option.kind} package`}`}
              onClick={() => void onAdd(slug, { kind: "registry", name: entry.name, version: entry.version, option: option.key })}
            >
              Add ({option.kind === "remote" ? "remote" : option.kind})
            </Button>
          ))}
        </span>
      )}
    </li>
  );
}

/** The review: what runs and where its calls go first, then each tool with its marks and choices. */
export function McpReviewModal({
  pluginId,
  onClose,
  onDone,
}: {
  readonly pluginId: string;
  readonly onClose: () => void;
  readonly onDone: (outcome: Awaited<ReturnType<typeof mcpActions.approve>>) => void;
}) {
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => mcpActions.show(client, pluginId));
  const [choices, setChoices] = useState<Readonly<Record<string, McpToolChoice>>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const review = data?.review;
  useResetOnChange([review?.version], () => setChoices({}));
  const choose = (name: string, choice: McpToolChoice): void =>
    setChoices((current) => ({ ...current, [name]: { ...current[name], ...choice } }));
  const decide = async (approve: boolean): Promise<void> => {
    if (review === undefined) return;
    setBusy(true);
    // What approval saves is what the review shows: every tool's effect, sent explicitly, and the floors the person
    // chose (the owner applies the suggested and preset floors itself, which the review already shows).
    const shown = Object.fromEntries(
      review.tools
        .filter((tool) => tool.state !== "removed")
        .map((tool) => {
          const choice = choices[tool.name] ?? {};
          const disabled = choice.disabled ?? tool.state === "disabled";
          const effect = shownEffect(tool, choice);
          return [
            tool.name,
            disabled
              ? { disabled: true }
              : { ...(effect === undefined ? {} : { effect }), ...(choice.floor === undefined ? {} : { floor: choice.floor }) },
          ];
        }),
    );
    const outcome = approve
      ? await mcpActions.approve(client, review, shown)
      : await mcpActions.reject(client, review.pluginId, review.version);
    setBusy(false);
    if (outcome.ok) onDone(outcome);
    else setFailure(outcome.message);
  };
  const waiting = review === undefined ? [] : review.tools.filter((tool) => tool.state !== "removed");
  const blocked = review === undefined || !approvable(review, choices);
  // A version probed unsandboxed or nested is approved with `tavi mcp approve … --unsandboxed|--nested`, never from a page.
  const weaker = review !== undefined && review.transport === "stdio" && review.sandboxState !== "srt";
  return (
    <Modal title={`Review ${pluginId}${review === undefined ? "" : `@${review.version}`}`} wide busy={busy} onClose={onClose}>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        {null}
      </LoadState>
      {review === undefined ? null : (
        <div className="mcp-review">
          {review.notices.map((notice) => (
            <Notice key={notice.kind}>
              {notice.title}. {notice.summary}
            </Notice>
          ))}
          <p>
            <strong>{review.reviewState}</strong>, sandbox:{" "}
            {review.sandboxState === "srt" ? "sandboxed" : review.sandboxState === "nested" ? "nested (weaker)" : "not sandboxed"}
            {review.serverInfo === undefined ? null : (
              <span className="muted">
                {" "}
                — the server says it is {review.serverInfo.name} {review.serverInfo.version}
              </span>
            )}
          </p>
          <ul className="muted">
            {[...review.launch, ...review.disclosure].map((line) => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
          {review.changes === undefined ? null : (
            <Notice as="div" role="note" aria-label={`Changed since ${review.changes.since}`}>
              Changed since {review.changes.since} (approved)
              {review.changes.lines.length === 0 ? ": nothing in what runs or what it reaches." : ":"}
              {review.changes.lines.length === 0 ? null : (
                <ul>
                  {review.changes.lines.map((line) => (
                    <li key={line}>
                      <code>{line}</code>
                    </li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
          {review.instructions === undefined ? null : (
            <details>
              <summary>Its instructions (shown to you, never to the model)</summary>
              <pre>{review.instructions}</pre>
            </details>
          )}
          {(review.warnings ?? []).length === 0 ? null : (
            <Notice as="div" role="note" aria-label="Warnings">
              Before you approve:
              <ul>
                {(review.warnings ?? []).map((warning) => (
                  // An overlap's remedy is this page's own control, not the terminal's `--disable`.
                  <li key={warning}>
                    {warning}
                    {warning.endsWith(OVERLAP) ? "; leave out the ones you do not need" : ""}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {review.probedAt === undefined ? <Notice>Not probed yet: probe it to list its tools.</Notice> : null}
          <table className="mcp-tools">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Effect</th>
                <th>Floor</th>
                <th>Leave out</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((tool) => {
                const choice = choices[tool.name] ?? {};
                const current = shownEffect(tool, choice);
                const marks = [
                  tool.doubtful ? "DOUBTFUL: claims read-only but has a write name" : undefined,
                  tool.flagged ? flaggedMark(tool.flaggedAt ?? []) : undefined,
                  "problem" in tool.schema ? `SCHEMA: ${tool.schema.problem}` : undefined,
                  tool.state === "withheld" ? "CHANGED since it was approved" : undefined,
                  tool.state === "pending" && review.reviewState === "approved" ? "NEW" : undefined,
                ].filter((mark): mark is string => mark !== undefined);
                return (
                  <Fragment key={tool.name}>
                    <tr>
                      <td>
                        <strong>{tool.shown.name}</strong>{" "}
                        <span className="muted">
                          {tool.toolId} · {tool.state}
                        </span>
                        {tool.shown.description === undefined ? null : <div className="muted">{tool.shown.description.slice(0, 300)}</div>}
                        {marks.map((mark) => (
                          <Notice as="div" key={mark}>
                            {mark}
                          </Notice>
                        ))}
                      </td>
                      <td>
                        <Select
                          aria-label={`Effect of ${tool.shown.name}`}
                          value={current ?? ""}
                          disabled={choice.disabled === true}
                          onChange={(event) => {
                            const effect = EFFECTS.find((candidate) => candidate === event.target.value);
                            if (effect !== undefined) choose(tool.name, { effect });
                          }}
                        >
                          {current === undefined ? <option value="">Choose…</option> : null}
                          {EFFECTS.map((effect) => (
                            <option key={effect} value={effect}>
                              {effect}
                              {effect === tool.suggestedEffect ? " (suggested)" : ""}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td>
                        <Select
                          aria-label={`Floor of ${tool.shown.name}`}
                          value={shownFloor(tool, choice)}
                          disabled={choice.disabled === true}
                          onChange={(event) => {
                            const floor = FLOORS.find((candidate) => candidate === event.target.value);
                            if (floor !== undefined) choose(tool.name, { floor });
                          }}
                        >
                          {FLOORS.map((floor) => (
                            <option key={floor} value={floor}>
                              {floor === "low" ? "none (low)" : floor}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Leave out ${tool.shown.name}`}
                          checked={choice.disabled ?? tool.state === "disabled"}
                          onChange={(event) => choose(tool.name, { disabled: event.target.checked })}
                        />
                      </td>
                    </tr>
                    {/* Before → after across the whole table, not wrapped word by word in the Tool column. */}
                    {tool.changedFields === undefined ? null : (
                      <tr className="mcp-tool-changes">
                        <td colSpan={4}>
                          <DefinitionChanges changes={tool.changedFields} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {blocked ? <Notice>Choose an effect, or leave out, every DOUBTFUL or FLAGGED tool before approving.</Notice> : null}
          {weaker ? (
            <Notice>
              It was probed {review.sandboxState === "none" ? "unsandboxed" : "in the weaker nested sandbox"}: approve it with{" "}
              <code>
                tavi mcp approve {review.pluginId} {review.version} --{review.sandboxState === "none" ? "unsandboxed" : "nested"}
              </code>
              .
            </Notice>
          ) : null}
          {failure === undefined ? null : <Failure>{failure}</Failure>}
          <div className="actions">
            {review.reviewState === "proposed" ? (
              <Button variant="danger" disabled={busy} onClick={() => void decide(false)}>
                Reject {review.version}
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={busy || blocked || weaker || review.probedAt === undefined}
              onClick={() => void decide(true)}
            >
              Approve {review.version}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function McpLogsModal({ pluginId, onClose }: { readonly pluginId: string; readonly onClose: () => void }) {
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => mcpActions.logs(client, pluginId));
  return (
    <Modal title={`Log of ${pluginId}`} wide onClose={onClose}>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        {null}
      </LoadState>
      {data === undefined ? null : data.logs.lines.length === 0 ? (
        <Empty>Nothing logged yet.</Empty>
      ) : (
        <pre className="mcp-log">{data.logs.lines.join("\n")}</pre>
      )}
    </Modal>
  );
}
