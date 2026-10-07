import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ deleteMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { googleRiscEvent: { deleteMany: h.deleteMany } },
}));

import { GoogleRisc } from "./retention";

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";

describe("GoogleRisc.retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    h.deleteMany.mockResolvedValue({ count: 4 });
  });

  it("deletes only rows older than 30 days", async () => {
    const now = new Date("2026-10-07T00:00:00Z");
    expect(await GoogleRisc.retention(now)).toBe(4);
    const cutoff = h.deleteMany.mock.calls[0]?.[0].where.receivedAt.lt as Date;
    expect(cutoff.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("makes no query in a dev process sharing the live database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", LIVE);
    expect(await GoogleRisc.retention()).toBe(0);
    expect(h.deleteMany).not.toHaveBeenCalled();
  });
});
