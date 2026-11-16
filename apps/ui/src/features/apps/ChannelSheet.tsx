import { useCallback, useState } from "react";

import type { ChannelDescriptor, ChannelsCatalogAnswer, ChannelsPeopleAnswer } from "@tavi/contracts";

import type { SettingsClient } from "../../lib/ipc.js";
import { Modal } from "../../ui/Modal.js";
import { Failure, Pending } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { type Added, ChannelForm, PairOperator, channels, simple, useLatest } from "../welcome/channel-setup.js";

/**
 * A channel set up with keys, added from Discover in one sheet: its setup
 * help and the pages it starts at, its keys typed and tested, then — for a
 * channel that pairs — the person pairs themself with a one-time code; for
 * one that does not, what its check said setting it up still asks. Every
 * word about the channel comes from its descriptor and its check.
 */
export function ChannelSheet({
  client,
  workspaceId,
  providerId,
  name,
  onClose,
  onDone,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly providerId: string;
  /** The channel's name as Discover lists it. */
  readonly name: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const read = useCallback(async () => {
    const [catalog, people] = await Promise.all([
      channels<ChannelsCatalogAnswer>(client, { action: "catalog" }),
      channels<ChannelsPeopleAnswer>(client, { action: "people", workspaceId }),
    ]);
    if (!catalog.ok) return catalog;
    if (!people.ok) return people;
    const descriptor = catalog.value.channels.find((candidate) => candidate.providerId === providerId);
    return descriptor === undefined
      ? { ok: false as const, message: `${name} is no longer installed.` }
      : { ok: true as const, value: { descriptor, operator: people.value.operator } };
  }, [client, workspaceId, providerId, name]);
  const { value: loaded } = useLatest(read);
  const [added, setAdded] = useState<Added>();
  const [paired, setPaired] = useState(false);
  return (
    <Modal title={`Add ${name}`} wide onClose={added === undefined ? onClose : onDone}>
      {loaded === undefined ? (
        <Pending className="notice" status />
      ) : !loaded.ok ? (
        <Failure>{loaded.message}</Failure>
      ) : !simple(loaded.value.descriptor) ? (
        <div className="apps-step stack">
          <p role="status">{`${name} needs settings this sheet does not ask for: add it in Settings → Channels.`}</p>
          <div className="actions">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : added === undefined ? (
        <ChannelForm client={client} workspaceId={workspaceId} descriptor={loaded.value.descriptor} onBack={onClose} onAdded={setAdded} />
      ) : (
        <AddedStep
          descriptor={loaded.value.descriptor}
          added={added}
          operator={loaded.value.operator}
          paired={paired}
          client={client}
          workspaceId={workspaceId}
          onPaired={() => setPaired(true)}
          onDone={onDone}
        />
      )}
    </Modal>
  );
}

function AddedStep(props: {
  readonly descriptor: ChannelDescriptor;
  readonly added: Added;
  readonly operator: string | undefined;
  readonly paired: boolean;
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly onPaired: () => void;
  readonly onDone: () => void;
}) {
  const { added } = props;
  // A channel that pairs: the person pairs themself here, unless a workspace has no operator to pair.
  if (props.descriptor.pairing !== undefined && props.operator !== undefined && !props.paired)
    return (
      <PairOperator
        client={props.client}
        workspaceId={props.workspaceId}
        channel={added}
        principalId={props.operator}
        onPaired={props.onPaired}
      />
    );
  return (
    <div className="apps-step stack">
      <p role="status">
        {props.paired ? `Paired on ${added.label}: your messages there reach Tavi.` : `${added.label} is added and answers.`}
      </p>
      {added.setup?.lines.map((line) => (
        <p key={line} className="settings-description">
          {line}
        </p>
      ))}
      {added.setup?.link === undefined ? null : (
        <p>
          <a href={added.setup.link.url} target="_blank" rel="noopener noreferrer">
            {added.setup.link.label}
          </a>
        </p>
      )}
      <div className="actions">
        <Button variant="primary" onClick={props.onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
