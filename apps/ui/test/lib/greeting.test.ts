import { describe, expect, it } from "vitest";

import { greeting } from "../../src/lib/time.js";

describe("a new chat's greeting", () => {
  it("follows the workspace zone's clock, not the browser's", () => {
    // 10:30 UTC is morning in London and evening in Tokyo (19:30).
    const at = Date.parse("2026-01-15T10:30:00Z");
    expect(greeting("Europe/London", at)).toBe("Good morning");
    expect(greeting("Asia/Tokyo", at)).toBe("Good evening");
  });

  it("turns at 05:00, 12:00 and 18:00", () => {
    const utc = (time: string) => Date.parse(`2026-01-15T${time}:00Z`);
    expect(greeting("UTC", utc("04:59"))).toBe("Good evening");
    expect(greeting("UTC", utc("05:00"))).toBe("Good morning");
    expect(greeting("UTC", utc("11:59"))).toBe("Good morning");
    expect(greeting("UTC", utc("12:00"))).toBe("Good afternoon");
    expect(greeting("UTC", utc("17:59"))).toBe("Good afternoon");
    expect(greeting("UTC", utc("18:00"))).toBe("Good evening");
  });
});
