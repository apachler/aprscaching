// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { sentState } from "../src/shack.js";
import { OUTBOX_QUEUED_TTL_S } from "../src/retention.js";

describe("the delivery state of a sent message", () => {
  const now = 1_000_000;

  it("is acknowledged once the instance heard the station's ack, whatever path it took", () => {
    expect(sentState({ ts: now - 10, ackedAt: now - 5 }, now)).toBe("acked");
    expect(sentState({ ts: now - 10, ackedAt: now - 5, outboxId: 3 }, now)).toBe("acked");
  });

  it("is sent when a radio sent it", () => {
    expect(sentState({ ts: now - 10 }, now)).toBe("sent");
  });

  it("through the instance: queued until the box reports it, then sent", () => {
    expect(sentState({ ts: now - 10, outboxId: 3 }, now)).toBe("queued");
    expect(sentState({ ts: now - 10, outboxId: 3, sentAt: now - 2 }, now)).toBe("sent");
  });

  it("through the instance: failed once older than the outbox drains", () => {
    expect(sentState({ ts: now - OUTBOX_QUEUED_TTL_S - 1, outboxId: 3 }, now)).toBe("failed");
    expect(sentState({ ts: now - OUTBOX_QUEUED_TTL_S, outboxId: 3 }, now)).toBe("queued");
  });
});
