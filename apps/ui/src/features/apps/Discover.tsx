import { useEffect, useState } from "react";

import type { CatalogEntry, CatalogRef } from "@tavi/contracts";

import { LoadState, SearchField, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { mcpActions } from "../settings/plugins-api.js";
import { ChannelSheet } from "./ChannelSheet.js";
import { appActions } from "./apps-api.js";
import { mapOutcome } from "../../lib/ipc.js";
import { AddServerForm, DiscoverPanel } from "../settings/McpServers.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { BADGE_WORDS, monogram } from "./model.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Confirm.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * Discover: Tavi's presets,
 * installed apps not yet set up, the channels, then the MCP Registry for
 * words typed. A plain visit sends nothing out; the registry's listings are
 * marked as unreviewed, because each tool is reviewed only when added.
 */

const SECTION_TITLES = {
  presets: "Tavi presets",
  installed: "Installed, not set up",
  channels: "Channels",
  registry: "MCP Registry",
} as const;

/** How long typing settles before the catalog is asked again. */
const SEARCH_SETTLE_MS = 350;

export function Discover({
  initialQuery = "",
  onOpen,
}: {
  readonly initialQuery?: string | undefined;
  readonly onOpen: (appId: string, connect: boolean) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const [typed, setTyped] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  // Tavi's own entries come from the owner's catalog, filtered here; the registry is searched by its own panel below.
  const { data, error, loading, reload } = useLoaded(() => appActions.catalog(client, workspaceId, ""));
  const { busy, note, run } = useAction(reload);
  const words = query.trim().toLowerCase();
  const sections = (data?.catalog.sections ?? [])
    .filter((section) => section.section !== "registry")
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => words === "" || `${entry.name} ${entry.summary}`.toLowerCase().includes(words)),
    }));
  const [channelSheet, setChannelSheet] = useState<{ readonly providerId: string; readonly name: string }>();
  // A second way into a server already added, offered as a switch before anything is removed.
  const [switching, setSwitching] = useState<SwitchOffer & { readonly ref: CatalogRef }>();
  const add = (entry: CatalogEntry, option?: string): void => {
    // A channel set up with keys is added in its own sheet: its keys typed and tested, then paired.
    if (entry.ref.kind === "channel" && entry.auth !== "oauth") {
      setChannelSheet({ providerId: entry.ref.providerId, name: entry.name });
      return;
    }
    void run(`add:${entry.name}`, async () => {
      const ref = entry.ref.kind === "registry" && option !== undefined ? { ...entry.ref, option } : entry.ref;
      const added = await appActions.add(client, workspaceId, ref);
      if (added.ok) onOpen(added.value.added.appId, true);
      // Another way into a server already added (Todoist's sign-in or token): the switch is offered, not an error.
      const offer = added.ok ? undefined : switchOfferOf(added.details);
      if (offer !== undefined) {
        setSwitching({ ...offer, ref });
        return { ok: true, value: undefined };
      }
      return mapOutcome(added, () => undefined);
    });
  };
  // A server added here opens on the app the owner made of it, found by its plugin id.
  const addServer = async (slug: string, form: Parameters<typeof mcpActions.add>[2]): Promise<boolean> => {
    let pluginId: string | undefined;
    await run("mcp:add", async () => {
      const added = await mcpActions.addServer(client, slug, form);
      if (!added.ok) return added;
      pluginId = added.value.pluginId;
      return { ok: true, value: added.value.message };
    });
    if (pluginId === undefined) return false;
    const listed = await appActions.list(client, workspaceId);
    const app = listed.ok
      ? listed.value.apps.find((candidate) => pluginId !== undefined && candidate.source.pluginIds.includes(pluginId))
      : undefined;
    if (app !== undefined) onOpen(app.appId, true);
    return true;
  };
  return (
    <div className="apps-discover">
      <SearchField value={typed} placeholder="Search Tavi's apps" label="Search apps" onChange={setTyped} />
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <StatusNote note={note} />
      </LoadState>
      {data !== undefined && sections.every((section) => section.entries.length === 0) ? (
        <Empty>Nothing of Tavi's matches "{query}". Search the MCP Registry below.</Empty>
      ) : null}
      {sections
        .filter((section) => section.entries.length > 0)
        .map((section) => (
          <section key={section.section} aria-labelledby={`apps-section-${section.section}`} className="apps-catalog-section">
            <h2 id={`apps-section-${section.section}`} className="settings-section-title">
              {SECTION_TITLES[section.section]}
            </h2>
            <ul className="apps-grid">
              {section.entries.map((entry) => (
                <li key={`${entry.ref.kind}:${entry.name}`}>
                  <CatalogCard
                    entry={entry}
                    busy={busy !== undefined}
                    onAdd={(option) => add(entry, option)}
                    onOpen={() => entry.appId !== undefined && onOpen(entry.appId, false)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      <section aria-labelledby="apps-section-registry" className="apps-catalog-section">
        <h2 id="apps-section-registry" className="settings-section-title">
          MCP Registry
        </h2>
        <p className="muted">Tavi does not review registry listings; you review each tool before the agent can use it.</p>
        <DiscoverPanel busy={busy !== undefined} onAdd={addServer} />
      </section>
      <details className="apps-by-address">
        <summary className="disclosure">Add an MCP server by its address or npm package</summary>
        <AddServerForm busy={busy !== undefined} onAdd={addServer} />
      </details>
      {switching === undefined ? null : (
        <Confirm
          title={`Switch ${switching.name} to ${switching.toName}?`}
          message={`Tavi keeps one ${switching.toName.replace(/ \(.*\)$/, "")}. Switching removes ${switching.pluginIds.join(", ")} with what it keeps: its token or sign-in, the choices on its page, and who may use it. ${switching.toName} is added in its place, and you review its tools again.`}
          action={`Switch to ${switching.toName}`}
          onClose={() => setSwitching(undefined)}
          onConfirm={async () => {
            const { ref } = switching;
            await run(`add:${switching.toName}`, async () => {
              const added = await appActions.add(client, workspaceId, ref, true);
              if (added.ok) onOpen(added.value.added.appId, true);
              return mapOutcome(added, () => undefined);
            });
          }}
        />
      )}
      {channelSheet === undefined ? null : (
        <ChannelSheet
          client={client}
          workspaceId={workspaceId}
          providerId={channelSheet.providerId}
          name={channelSheet.name}
          onClose={() => setChannelSheet(undefined)}
          onDone={() => {
            setChannelSheet(undefined);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function CatalogCard({
  entry,
  busy,
  onAdd,
  onOpen,
}: {
  readonly entry: CatalogEntry;
  readonly busy: boolean;
  readonly onAdd: (option?: string) => void;
  readonly onOpen: () => void;
}) {
  const [option, setOption] = useState(entry.options[0]);
  return (
    <article className="card-flat apps-card" aria-label={entry.name}>
      <span className="apps-icon" aria-hidden="true">
        {monogram(entry.name)}
      </span>
      <h3>{entry.name}</h3>
      <p className="muted">{entry.summary}</p>
      <p className="apps-badges">
        {entry.badges.map((badge) => (
          <span key={badge} className="badge">
            {BADGE_WORDS[badge]}
          </span>
        ))}
      </p>
      <div className="actions">
        {entry.installed && entry.appId !== undefined ? (
          <Button size="sm" onClick={onOpen}>
            {entry.ref.kind === "installed" ? "Set up" : "Open"}
          </Button>
        ) : entry.ref.kind === "registry" && entry.options.length > 1 ? (
          <>
            <Select aria-label={`How to add ${entry.name}`} value={option ?? ""} onChange={(event) => setOption(event.target.value)}>
              {entry.options.map((each) => (
                <option key={each} value={each}>
                  {each}
                </option>
              ))}
            </Select>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onAdd(option)}>
              Add
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onAdd(option)}>
            Add
          </Button>
        )}
      </div>
    </article>
  );
}

/** What a refused add offers to switch: the app added by the other way in, and the preset that would replace it. */
interface SwitchOffer {
  readonly name: string;
  readonly pluginIds: readonly string[];
  readonly toName: string;
}

function switchOfferOf(details: Readonly<Record<string, unknown>> | undefined): SwitchOffer | undefined {
  const offer = details?.["switch"] as Partial<SwitchOffer> | undefined;
  return typeof offer?.name === "string" && typeof offer.toName === "string" && Array.isArray(offer.pluginIds)
    ? { name: offer.name, toName: offer.toName, pluginIds: offer.pluginIds.filter((id): id is string => typeof id === "string") }
    : undefined;
}
