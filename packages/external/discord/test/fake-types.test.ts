import type * as Fake from "@tavi/test-support/discord";
import { describe, expectTypeOf, it } from "vitest";

import type { RateLimitClock } from "../src/buckets.js";
import type { GatewayClock, WebSocketLike } from "../src/gateway.js";

/** The fake Discord declares its own copies of these: they must stay the connector's types, both ways. */
describe("the fake Discord's clock and socket types", () => {
  it("are the connector's", () => {
    expectTypeOf<Fake.GatewayClock>().toEqualTypeOf<GatewayClock>();
    expectTypeOf<Fake.RateLimitClock>().toEqualTypeOf<RateLimitClock>();
    expectTypeOf<Fake.WebSocketLike>().toExtend<WebSocketLike>();
    expectTypeOf<WebSocketLike>().toExtend<Fake.WebSocketLike>();
    expectTypeOf<Fake.FakeSocket>().toExtend<WebSocketLike>();
  });
});
