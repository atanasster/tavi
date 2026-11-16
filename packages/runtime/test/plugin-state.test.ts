import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/persistence/migrations.js";
import { SqlitePluginRepository } from "../src/persistence/plugin-repository.js";
import { TaviError } from "@tavi/contracts";

describe("plugin state", () => {
  it("stores, retrieves, limits, and clears plugin state in SqlitePluginRepository", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      const repo = new SqlitePluginRepository(() => db);

      // Initially empty
      expect(repo.loadPluginState("acme.test")).toEqual({});

      // Put state in namespaces
      const now = "2026-10-07T12:00:00.000Z";
      repo.putPluginState("acme.test", "settings", { theme: "dark", count: 42 }, now);
      repo.putPluginState("acme.test", "feed_cache", ["item1", "item2"], now);

      const loaded = repo.loadPluginState("acme.test");
      expect(loaded).toEqual({
        settings: { theme: "dark", count: 42 },
        feed_cache: ["item1", "item2"],
      });

      // Update existing namespace
      repo.putPluginState("acme.test", "settings", { theme: "light", count: 43 }, "2026-10-07T12:05:00.000Z");
      expect(repo.loadPluginState("acme.test")["settings"]).toEqual({ theme: "light", count: 43 });

      // Rejects invalid namespace
      expect(() => repo.putPluginState("acme.test", "bad namespace!", "val", now)).toThrow(TaviError);
      expect(() => repo.putPluginState("acme.test", "a".repeat(65), "val", now)).toThrow(TaviError);

      // Enforces namespace count limit (max 16)
      for (let i = 3; i <= 16; i++) {
        repo.putPluginState("acme.test", `ns_${i}`, `val_${i}`, now);
      }
      expect(() => repo.putPluginState("acme.test", "ns_17", "overflow", now)).toThrow(/namespace limit/);

      // Existing namespace can still be updated even at limit
      expect(() => repo.putPluginState("acme.test", "ns_16", "updated_val", now)).not.toThrow();

      // Enforces total size limit (256 KiB)
      const bigString = "x".repeat(260 * 1024);
      expect(() => repo.putPluginState("other.plugin", "big", bigString, now)).toThrow(/storage limit/);

      // Multi-byte UTF-8 byte counting via octet_length
      // "€" is 3 bytes in UTF-8, 1 char in UTF-16
      const euroString = "€".repeat(90 * 1024); // 90,000 chars * 3 = 270,000 bytes > 256 KiB
      expect(() => repo.putPluginState("euro.plugin", "ns1", euroString, now)).toThrow(/storage limit/);

      // Rejects reserved namespaces
      expect(() => repo.putPluginState("acme.test", "__proto__", "evil", now)).toThrow(/reserved plugin state namespace/);
      expect(() => repo.putPluginState("acme.test", "constructor", "evil", now)).toThrow(/reserved plugin state namespace/);
      expect(() => repo.putPluginState("acme.test", "prototype", "evil", now)).toThrow(/reserved plugin state namespace/);

      // Rejects non-serializable values
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      expect(() => repo.putPluginState("acme.test", "circular", circular, now)).toThrow(/must be JSON serializable/);
      expect(() => repo.putPluginState("acme.test", "bigint", { num: 123n }, now)).toThrow(/must be JSON serializable/);

      // Corrupted JSON throws UNAVAILABLE
      db.prepare("INSERT INTO tavi_plugin_state (plugin_id, namespace, value_json, updated_at) VALUES (?, ?, ?, ?)").run(
        "corrupt.plugin",
        "bad_json",
        "{not valid json",
        now,
      );
      expect(() => repo.loadPluginState("corrupt.plugin")).toThrow(/contains malformed JSON/);

      // Clear state
      expect(repo.clearPluginState("acme.test")).toBe(true);
      expect(repo.loadPluginState("acme.test")).toEqual({});
    } finally {
      db.close();
    }
  });
});
