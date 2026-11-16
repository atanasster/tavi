import type { RoutineSnapshot } from "@tavi/contracts";

import { Summary } from "../../ui/Parts.js";
import { json } from "./api.js";

/** One setting of a routine's configuration: where it is, what it is called, and its value in words. */
export interface SettingField {
  readonly path: string;
  readonly label: string;
  readonly value: string;
}

/** An object key in words ("targetIds" is "target ids"). */
function keyWords(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** What a field is called: its path's parts as `words` gives them, the first capitalised ("Delivery › target ids"). */
function fieldLabel(words: readonly string[]): string {
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" › ");
}

/** A leaf value in words. */
function leafText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** An array element's name in a path: its own id where it has one, so a reordered list still compares by item. */
function elementKey(value: unknown, index: number): string {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const field of ["id", "skillId", "targetId"]) if (typeof record[field] === "string") return record[field] as string;
  }
  return String(index + 1);
}

/**
 * An array element as its label says it: its name where it has one, else the id its author wrote (a trigger's, a
 * skill's), else its place in the list — never an id the owner made up, such as a delivery target's.
 */
function elementWords(value: unknown, index: number): string {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const field of ["name", "label", "title", "id", "skillId"]) {
      const word = record[field];
      if (typeof word === "string" && word !== "") return word;
    }
  }
  return `Item ${index + 1}`;
}

/** `words` runs beside `parts`: an object key in words, an array element by its name (`parts` keeps its id, by which two revisions compare). */
function flatten(value: unknown, parts: readonly string[], words: readonly string[], into: SettingField[]): void {
  if (Array.isArray(value)) {
    // A list of plain values is one setting; a list of objects is one per item.
    if (value.every((item) => item === null || typeof item !== "object")) {
      into.push({ path: parts.join("."), label: fieldLabel(words), value: value.length === 0 ? "None" : value.map(leafText).join(", ") });
      return;
    }
    value.forEach((item, index) => {
      flatten(item, [...parts, elementKey(item, index)], [...words, elementWords(item, index)], into);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && parts.length > 0) into.push({ path: parts.join("."), label: fieldLabel(words), value: "None" });
    for (const [key, item] of entries) flatten(item, [...parts, key], [...words, keyWords(key)], into);
    return;
  }
  into.push({ path: parts.join("."), label: fieldLabel(words), value: leafText(value) });
}

/** A routine's configuration as one setting per line, in its own order. */
function snapshotFields(snapshot: RoutineSnapshot): readonly SettingField[] {
  const fields: SettingField[] = [];
  flatten(snapshot, [], [], fields);
  return fields;
}

/** A setting that differs between two revisions: its value in each ("Not set" where one has none). */
export interface SettingChange {
  readonly path: string;
  readonly label: string;
  readonly before: string;
  readonly now: string;
}

/** Each setting `revision` has otherwise than `current`, in `current`'s order, then what only `revision` has. */
function snapshotChanges(revision: RoutineSnapshot, current: RoutineSnapshot): readonly SettingChange[] {
  const then = new Map(snapshotFields(revision).map((field) => [field.path, field]));
  const now = new Map(snapshotFields(current).map((field) => [field.path, field]));
  const paths = [...new Set([...now.keys(), ...then.keys()])];
  return paths.flatMap((path) => {
    const before = then.get(path);
    const after = now.get(path);
    const was = before?.value ?? "Not set";
    const is = after?.value ?? "Not set";
    if (was === is) return [];
    return [{ path, label: (after ?? before)!.label, before: was, now: is }];
  });
}

/** Settings shown elsewhere on the routine's page: its objective, its researcher's instructions and its skills. */
const SHOWN_ELSEWHERE = /^(objective$|agent\.instructions$|skills(\.|$))/;

/**
 * A routine's current settings, one per line, with the raw configuration
 * (and its state) behind a disclosure.
 */
export function RoutineSettingsView({ snapshot, state }: { readonly snapshot: RoutineSnapshot; readonly state: unknown }) {
  const fields = snapshotFields(snapshot).filter((field) => !SHOWN_ELSEWHERE.test(field.path));
  return (
    <>
      <Summary items={fields.map((field) => [field.label, field.value] as const)} />
      <details>
        <summary>Raw configuration (JSON)</summary>
        <pre>{json(snapshot)}</pre>
        <pre>{json(state)}</pre>
      </details>
    </>
  );
}

/**
 * What restoring revision `revision` would change: each setting it has
 * otherwise than the current revision, now and as it would be, and its raw
 * configuration behind a disclosure.
 */
export function RevisionChanges({
  revision,
  snapshot,
  current,
  currentRevision,
}: {
  readonly revision: number;
  readonly snapshot: RoutineSnapshot;
  readonly current: RoutineSnapshot;
  readonly currentRevision: number;
}) {
  const changes = snapshotChanges(snapshot, current);
  return (
    <div className="revision-changes">
      {revision === currentRevision ? (
        <p>This is the current revision.</p>
      ) : changes.length === 0 ? (
        <p>Its settings are the same as the current revision's ({currentRevision}).</p>
      ) : (
        <>
          <p>
            Restoring it changes {changes.length === 1 ? "one setting" : `${changes.length} settings`} from the current revision (
            {currentRevision}):
          </p>
          <dl className="revision-diff" aria-label={`Changes from revision ${currentRevision}`}>
            {changes.map((change) => (
              <div key={change.path}>
                <dt>{change.label}</dt>
                <dd>
                  <span className="revision-diff-now">
                    <span className="revision-diff-tag">Now</span> {change.now}
                  </span>
                  <span className="revision-diff-then">
                    <span className="revision-diff-tag">Revision {revision}</span> {change.before}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <details>
        <summary>Raw configuration (JSON)</summary>
        <pre>{json(snapshot)}</pre>
      </details>
    </div>
  );
}
