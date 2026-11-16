import { expect, it } from "vitest";
import * as runtime from "../src/index.js";

it("exports worker clients without exposing synchronous SQL handles or migrations", () => {
  expect(runtime.DatabaseClient).toBeTypeOf("function");
  for (const name of ["SqliteStore", "loadBetterSqlite3", "runMigrations"]) {
    expect(Object.keys(runtime)).not.toContain(name);
  }
});
