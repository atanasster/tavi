import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { clip } from "@tavi/contracts/util";
import { openDomainStore } from "@tavi/domain-kit";

import type { ItemOrigin, RawItem, StoredItem } from "../contracts.js";
import { ITEMS_MIGRATIONS } from "./schema.js";

/** The most of an item's text kept: enough to quote, not the article. */
export const ITEM_TEXT_MAX = 2_048;
export const ITEM_TITLE_MAX = 300;
/** Items one upsert takes. */
export const ITEMS_PER_WRITE = 500;

/** An item's id: its source and a hash of the source's own ref, stable across reads. */
export function itemIdOf(source: string, ref: string): string {
  return `${source}:${createHash("sha256").update(ref).digest("hex").slice(0, 24)}`;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

type ItemRow = {
  item_id: string;
  source: string;
  origin: ItemOrigin;
  topic_id: string | null;
  item_set: string | null;
  url: string;
  outlet: string;
  title: string;
  text: string;
  published_at: string | null;
  language: string | null;
  author_hash: string | null;
  metrics: string;
  fetched_at: string;
  expires_at: string;
};

const itemOf = (row: ItemRow): StoredItem => ({
  itemId: row.item_id,
  source: row.source,
  origin: row.origin,
  url: row.url,
  outlet: row.outlet,
  title: row.title,
  text: row.text,
  ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
  ...(row.language === null ? {} : { language: row.language }),
  ...(row.author_hash === null ? {} : { authorHash: row.author_hash }),
  metrics: JSON.parse(row.metrics) as Record<string, number>,
  fetchedAt: row.fetched_at,
  expiresAt: row.expires_at,
});

/** What an upsert stores an item under, besides the item itself. */
export interface ItemPlacement {
  readonly source: string;
  readonly origin: ItemOrigin;
  /** How long the source's terms let it be kept. */
  readonly ttlMs: number;
  readonly topicId?: string;
  /** A set relayed together (`ingest`) or read by one search, which `cluster` reads as one. */
  readonly itemSet?: string;
}

/**
 * `home/cache/items.db`: what reads returned, kept only for each
 * source's cache window. It lies under `home/cache/`, which backups leave out,
 * so a post its author deleted never outlives its window in a backup.
 */
export function openItemStore(path: string) {
  const db: DatabaseSync = openDomainStore(path, ITEMS_MIGRATIONS);

  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  /** Today's salt, made once a day; earlier days' salts are dropped, so yesterday's hashes link to nothing. */
  const saltFor = (day: string): string => {
    const row = db.prepare("SELECT salt FROM salts WHERE day = ?").get(day) as { salt: string } | undefined;
    if (row !== undefined) return row.salt;
    const salt = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO salts (day, salt) VALUES (?, ?)").run(day, salt);
    db.prepare("DELETE FROM salts WHERE day < ?").run(day);
    return salt;
  };

  /** A person's handle as the store may keep it: a hash salted per day. */
  const authorHash = (author: string, now: string): string =>
    createHash("sha256")
      .update(`${saltFor(now.slice(0, 10))}:${author.trim().toLowerCase()}`)
      .digest("hex")
      .slice(0, 16);

  /** Items by id that are still within their window, in the order asked. */
  const many = (itemIds: readonly string[], now: string): StoredItem[] => {
    if (itemIds.length === 0) return [];
    const read = db.prepare("SELECT * FROM items WHERE item_id = ? AND expires_at > ?");
    return itemIds.flatMap((itemId) => {
      const row = read.get(itemId, now) as ItemRow | undefined;
      return row === undefined ? [] : [itemOf(row)];
    });
  };

  return {
    db,

    authorHash,

    upsert(items: readonly RawItem[], placement: ItemPlacement, now: string): StoredItem[] {
      if (items.length > ITEMS_PER_WRITE) throw new Error(`at most ${String(ITEMS_PER_WRITE)} items are stored at once`);
      const expiresAt = new Date(Date.parse(now) + placement.ttlMs).toISOString();
      const write =
        db.prepare(`INSERT INTO items (item_id, source, origin, topic_id, item_set, url, outlet, title, text, published_at, language, author_hash, metrics, fetched_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (item_id) DO UPDATE SET topic_id = COALESCE(excluded.topic_id, items.topic_id), item_set = COALESCE(excluded.item_set, items.item_set), title = excluded.title,
          text = CASE WHEN excluded.text = '' THEN items.text ELSE excluded.text END, metrics = excluded.metrics, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`);
      // A name's hash is under the day's salt: the same name the same day is the same row.
      const seen = db.prepare("INSERT OR IGNORE INTO seen_authors (name_hash, day) VALUES (?, ?)");
      const ids: string[] = [];
      transaction(() => {
        for (const item of items) {
          const itemId = itemIdOf(placement.source, item.ref);
          const metrics = Object.fromEntries(Object.entries(item.metrics ?? {}).filter(([, value]) => Number.isFinite(value)));
          write.run(
            itemId,
            placement.source,
            placement.origin,
            placement.topicId ?? null,
            placement.itemSet ?? null,
            item.url,
            hostOf(item.url),
            clip(item.title, ITEM_TITLE_MAX, { squeeze: true }),
            clip(item.text ?? "", ITEM_TEXT_MAX, { squeeze: true }),
            item.publishedAt ?? null,
            item.language ?? null,
            item.author === undefined || item.author.trim() === "" ? null : authorHash(item.author, now),
            JSON.stringify(metrics),
            now,
            expiresAt,
          );
          ids.push(itemId);
          for (const name of [item.author, ...(item.authorNames ?? [])]) {
            if (name !== undefined && name.trim() !== "") seen.run(authorHash(name.replace(/^@/, ""), now), now.slice(0, 10));
          }
        }
      });
      return many(ids, now);
    },

    many,

    /** Whether `name` (a handle, with or without its @) is an author a read saw today. */
    seenAuthor(name: string, now: string): boolean {
      return (
        db
          .prepare("SELECT 1 FROM seen_authors WHERE name_hash = ? AND day = ?")
          .get(authorHash(name.trim().replace(/^@/, ""), now), now.slice(0, 10)) !== undefined
      );
    },

    /** A topic's items read since `since`, newest first. */
    forTopic(topicId: string, since: string, now: string, limit = 500): StoredItem[] {
      return (
        db
          .prepare(
            "SELECT * FROM items WHERE topic_id = ? AND fetched_at >= ? AND expires_at > ? ORDER BY fetched_at DESC, item_id LIMIT ?",
          )
          .all(topicId, since, now, limit) as ItemRow[]
      ).map(itemOf);
    },

    /** One relayed or searched set, in the order stored. */
    forSet(itemSet: string, now: string, limit = 5_000): StoredItem[] {
      return (
        db.prepare("SELECT * FROM items WHERE item_set = ? AND expires_at > ? ORDER BY rowid LIMIT ?").all(itemSet, now, limit) as ItemRow[]
      ).map(itemOf);
    },

    /** Drops what is past its window; run at start and before each sweep. */
    expire(now: string): number {
      db.prepare("DELETE FROM seen_authors WHERE day < ?").run(now.slice(0, 10));
      return Number(db.prepare("DELETE FROM items WHERE expires_at <= ?").run(now).changes);
    },

    forget(): void {
      db.exec("BEGIN IMMEDIATE; DELETE FROM items; DELETE FROM salts; DELETE FROM seen_authors; COMMIT;");
    },

    close(): void {
      db.close();
    },
  };
}

export type ItemStore = ReturnType<typeof openItemStore>;
