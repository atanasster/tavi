import type {
  ChannelDescriptor,
  ChannelsCatalogAnswer,
  ChannelsListAnswer,
  ChannelsPeopleAnswer,
  ConnectableApp,
  OnboardingFlowStep,
  OnboardingStatus,
} from "@tavi/contracts";
import { useCallback, useState } from "react";

import { ConnectSheet } from "../apps/ConnectSheet.js";
import { toolsByAccess } from "../apps/model.js";
import type { SettingsView } from "../shell/route.js";
import { appActions } from "../apps/apps-api.js";
import { useT, translateNow } from "../../lib/i18n.js";
import { mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { loadStatus } from "./onboarding-api.js";
import { Icon } from "../../ui/Icon.js";
import { Failure, Notice, Pending } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { type Added, ChannelForm, PairOperator, channels, simple, useLatest } from "./channel-setup.js";

/**
 * Setup's apps and channels steps on the canvas. An app card says what the app reads and opens the same
 * connect sheet the Apps page does; a channel is added from its descriptor,
 * tested, and is not set up until its operator is paired with a one-time code
 * and confirmed it was them. Everything else is a link to the full page.
 */

export interface ConnectStepProps {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly step: OnboardingFlowStep;
  readonly onStatus: (status: OnboardingStatus) => void;
  readonly onSettings: (view: SettingsView) => void;
}

/** The status again after a change, so the step's state comes from live facts. */
async function refresh(props: ConnectStepProps): Promise<void> {
  const status = await loadStatus(props.client, props.workspaceId);
  if (status.ok) props.onStatus(status.value);
}

// ------------------------------------------------------------------ apps

/**
 * What an app may do, in a sentence: its sign-in's own scope words (what the
 * connect sheet lists), else its tools, and that whatever changes or sends
 * something asks first.
 */
export function scopeSentence(app: ConnectableApp): string {
  const scopes = app.auth.kind === "oauth" || app.auth.kind === "device" ? app.auth.scopes : [];
  const accesses = toolsByAccess(app.tools).map((group) => group.access);
  const may =
    scopes.length > 0
      ? scopes.map((scope) => scope.says).join("; ")
      : translateNow(accesses.includes("read") ? "welcome.apps.mayRead" : "welcome.apps.mayWork", { app: app.name });
  const asks = accesses.some((access) => access !== "read") || scopes.some((scope) => scope.access !== "read");
  return translateNow("welcome.apps.scope", { may, asks: translateNow(asks ? "welcome.apps.asksFirst" : "welcome.apps.readOnly") });
}

/** The account the app is connected with in this workspace, when it is. */
const connectedHere = (app: ConnectableApp, workspaceId: string) =>
  app.accounts.find((account) => account.health === "ready" && account.workspaces.includes(workspaceId));

export function AppsStep(props: ConnectStepProps) {
  const { client, workspaceId } = props;
  const t = useT();
  const read = useCallback(async (): Promise<Outcome<readonly ConnectableApp[]>> => {
    const listed = await appActions.list(client, workspaceId);
    return mapOutcome(listed, (value) => value.apps);
  }, [client, workspaceId]);
  const { value: apps, reload } = useLatest(read);
  const [connecting, setConnecting] = useState<ConnectableApp>();
  if (apps === undefined) return <Pending className="notice" status />;
  if (!apps.ok) return <Failure>{apps.message}</Failure>;
  // The flow's featured apps, in its order (the host already dropped what is not installed).
  const featured = (props.step.featured ?? [])
    .map((id) => apps.value.find((app) => app.appId === id))
    .filter((app): app is ConnectableApp => app !== undefined);
  const settled = async (): Promise<void> => {
    setConnecting(undefined);
    await reload();
    await refresh(props);
  };
  return (
    <div className="welcome-connect">
      {featured.length === 0 ? (
        <Notice>{t("welcome.apps.none")}</Notice>
      ) : (
        <ul className="welcome-cards">
          {featured.map((app) => {
            const account = connectedHere(app, workspaceId);
            return (
              <li key={app.appId} className="welcome-card">
                <h2>{app.name}</h2>
                <p>{app.summary}</p>
                <p className="settings-description">{scopeSentence(app)}</p>
                {account !== undefined ? (
                  <p className="welcome-state">
                    <Icon name="check" size="sm" /> {t("welcome.apps.connectedAs", { account: account.identity ?? account.label })}
                  </p>
                ) : (
                  <Button size="sm" aria-label={t("welcome.apps.connect", { app: app.name })} onClick={() => setConnecting(app)}>
                    {t("welcome.action.connect")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p>
        <Button variant="link" onClick={() => props.onSettings("apps")}>
          {t("welcome.apps.seeAll")}
        </Button>
      </p>
      {connecting === undefined ? null : (
        <ConnectSheet
          client={client}
          workspaceId={workspaceId}
          app={connecting}
          onClose={() => void settled()}
          onConnected={() => void settled()}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ channels

interface ChannelsLoaded {
  readonly catalog: readonly ChannelDescriptor[];
  readonly list: ChannelsListAnswer;
  readonly people: ChannelsPeopleAnswer;
}

export function ChannelsStep(props: ConnectStepProps) {
  const { client, workspaceId } = props;
  const t = useT();
  const read = useCallback(async (): Promise<Outcome<ChannelsLoaded>> => {
    const [catalog, list, people] = await Promise.all([
      channels<ChannelsCatalogAnswer>(client, { action: "catalog", workspaceId }),
      channels<ChannelsListAnswer>(client, { action: "list", workspaceId }),
      channels<ChannelsPeopleAnswer>(client, { action: "people", workspaceId }),
    ]);
    if (!catalog.ok) return catalog;
    if (!list.ok) return list;
    if (!people.ok) return people;
    return { ok: true, value: { catalog: catalog.value.channels, list: list.value, people: people.value } };
  }, [client, workspaceId]);
  const { value: loaded, reload } = useLatest(read);
  const [chosen, setChosen] = useState<string>();
  const [added, setAdded] = useState<Added>();
  const [pairedOn, setPairedOn] = useState<string>();
  if (loaded === undefined) return <Pending className="notice" status />;
  if (!loaded.ok) return <Failure>{loaded.message}</Failure>;
  const featured = (props.step.featured ?? [])
    .map((id) => loaded.value.catalog.find((descriptor) => descriptor.providerId === id))
    .filter((descriptor): descriptor is ChannelDescriptor => descriptor !== undefined);
  const operator = loaded.value.people.operator;
  const bound = new Set(
    loaded.value.people.people.filter((person) => person.principalId === operator).map((person) => person.connectionId),
  );
  const ofFeatured = loaded.value.list.connections.filter(
    (connection) => connection.enabled && featured.some((descriptor) => descriptor.providerId === connection.providerId),
  );
  // Already paired (the step reopened): said, and no second bot offered.
  const paired = pairedOn ?? ofFeatured.find((connection) => bound.has(connection.connectionId))?.label;
  const seeAll = (
    <p>
      <Button variant="link" onClick={() => props.onSettings("messaging")}>
        {t("welcome.channels.seeAll")}
      </Button>
    </p>
  );
  if (paired !== undefined) {
    return (
      <div className="welcome-connect">
        <p className="welcome-state" role="status">
          <Icon name="check" size="sm" /> {t("welcome.channels.paired", { channel: paired })}
        </p>
        {seeAll}
      </div>
    );
  }
  // A connection of a featured kind, not yet paired to the operator, is offered to pair rather than added twice.
  const unpaired = ofFeatured.find((connection) => !bound.has(connection.connectionId));
  const descriptor = featured.find((candidate) => candidate.providerId === chosen);
  const pairingOn = added ?? (unpaired === undefined ? undefined : { connectionId: unpaired.connectionId, label: unpaired.label });
  return (
    <div className="welcome-connect">
      {operator === undefined ? (
        <Notice>{t("welcome.channels.noOperator")}</Notice>
      ) : pairingOn !== undefined ? (
        <PairOperator
          client={client}
          workspaceId={workspaceId}
          channel={pairingOn}
          principalId={operator}
          onPaired={() => {
            setPairedOn(pairingOn.label);
            void reload();
            void refresh(props);
          }}
        />
      ) : descriptor === undefined ? (
        featured.length === 0 ? (
          <Notice>{t("welcome.channels.none")}</Notice>
        ) : (
          <>
            {/* What choosing a channel does; the step's own text already says strangers are never answered. */}
            <p className="settings-description">{t("welcome.channels.scope")}</p>
            <div className="welcome-choices" role="group" aria-label={t("welcome.channels.group")}>
              {featured.map((candidate) =>
                simple(candidate) ? (
                  <Button key={candidate.providerId} className="welcome-choice" onClick={() => setChosen(candidate.providerId)}>
                    {candidate.label}
                  </Button>
                ) : (
                  <Button key={candidate.providerId} className="welcome-choice" onClick={() => props.onSettings("messaging")}>
                    {t("welcome.channels.inSettings", { channel: candidate.label })}
                  </Button>
                ),
              )}
            </div>
          </>
        )
      ) : (
        <ChannelForm
          client={client}
          workspaceId={workspaceId}
          descriptor={descriptor}
          onboardingStep="channels"
          onBack={() => setChosen(undefined)}
          backLabel={t("welcome.channels.back")}
          onAdded={(connection) => {
            setAdded(connection);
            void reload();
          }}
        />
      )}
      {seeAll}
    </div>
  );
}
