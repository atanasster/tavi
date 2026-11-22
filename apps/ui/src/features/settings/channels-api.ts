import type { ChannelDescriptor, ChannelsCatalogAnswer, ChannelsListAnswer, ChannelsPayload, ChannelsPeopleAnswer } from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, type Outcome, type SettingsClient } from "../../lib/ipc.js";

export type SettingValue = string | number | boolean;
export function request<T>(client: SettingsClient, payload: ChannelsPayload): Promise<Outcome<T>> {
  return ask<T>(
    client,
    "channels",
    { ...payload },
    {
      timeoutMs: null,
      refused: translateNow("settings.channels.refused"),
      unreachable: translateNow("settings.channels.unreachable"),
    },
  );
}
export interface Loaded {
  readonly catalog: readonly ChannelDescriptor[];
  readonly list: ChannelsListAnswer;
  readonly people: ChannelsPeopleAnswer["people"];
  /** Whether `people` was read: elsewhere than Allowed people a failed read leaves the page usable, saying nothing of who is allowed. */
  readonly peopleKnown: boolean;
  /** The workspace operator's own principal, when the owner named it: "This is me" allows a sender under it. */
  readonly operator?: string;
}
/** The page's data, with the people allowed: required on Allowed people, and only shown elsewhere. */
export async function load(client: SettingsClient, workspaceId: string, peopleRequired: boolean): Promise<Outcome<Loaded>> {
  const [catalog, list, bound] = await Promise.all([
    request<ChannelsCatalogAnswer>(client, { action: "catalog" }),
    request<ChannelsListAnswer>(client, { action: "list", workspaceId }),
    request<ChannelsPeopleAnswer>(client, { action: "people", workspaceId }),
  ]);
  if (!catalog.ok) return catalog;
  if (!list.ok) return list;
  if (!bound.ok && peopleRequired) return bound;
  const people = bound.ok ? bound.value.people : [];
  const operator = bound.ok ? bound.value.operator : undefined;
  return {
    ok: true,
    value: {
      catalog: catalog.value.channels,
      list: list.value,
      people,
      peopleKnown: bound.ok,
      ...(operator === undefined ? {} : { operator }),
    },
  };
}
export function labelOf(catalog: readonly ChannelDescriptor[], providerId: string): string {
  return catalog.find((descriptor) => descriptor.providerId === providerId)?.label ?? providerId;
}
