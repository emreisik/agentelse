import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  An1Evidence,
  An3Evidence,
  GaFindingCandidate,
} from "@/lib/website-analytics/analysis/types";

// Bu dosyanın kanıtladığı: adaylar dönem sırasıyla işlenir (koşul kuralında
// eski dönem yeniyi asla kapatmaz); eski dönem "stale" atlanır; reddedilmiş
// AN1'den sonra yeni AN1 (olay kuralı) yine yazılır; canlı tur aynı parmak
// izli OPEN gölge satırı yeniden adlandırıp kapatır ve canlı satır yazar;
// P2002 "refreshed" sayılır.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaFinding: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
      create: mocks.create,
    },
    $transaction: mocks.transaction,
  },
}));

const { persistCandidates } = await import("./persist");

const LINK = {
  id: "link-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  isMock: false,
};
const NOW = new Date("2026-10-07T10:00:00.000Z");

function an3(window: { from: string; to: string }): An3Evidence {
  return {
    v: 1,
    rule: "AN3",
    variant: "cro",
    window,
    page: "/pricing",
    sessions: 800,
    keyEvents: 4,
    rate: 0.005,
    restSessions: 9000,
    restKeyEvents: 270,
    restRate: 0.03,
    ratio: 0.17,
    threshold: 0.5,
    p: 0.001,
    bhAccepted: true,
    excludedDays: [],
    holidays: [],
  };
}

function an3Candidate(
  from: string,
  to: string,
  key: string,
): GaFindingCandidate {
  return {
    ruleKey: "AN3",
    kind: "OPPORTUNITY",
    subject: "page:/pricing",
    period: { grain: "WINDOW28", from, to, key },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    evidence: an3({ from, to }),
    impact: null,
    impactShare: 0.3,
  };
}

function an1Evidence(day: string): An1Evidence {
  return {
    v: 1,
    rule: "AN1",
    mode: "day",
    target: day,
    readings: [],
    primary: "sessions",
    excludedDays: [],
    breakdown: null,
    seasonalChecked: true,
    preliminary: false,
  };
}

function an1Candidate(day: string): GaFindingCandidate {
  return {
    ruleKey: "AN1",
    kind: "ANOMALY",
    subject: "site",
    period: { grain: "DAY", from: day, to: day, key: day },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    evidence: an1Evidence(day),
    impact: null,
    impactShare: 0.5,
  };
}

let createdIds = 0;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  createdIds = 0;
  mocks.findUnique.mockResolvedValue(null);
  mocks.findFirst.mockResolvedValue(null);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.create.mockImplementation(() => {
    createdIds += 1;
    return Promise.resolve({ id: `new-${createdIds}` });
  });
  mocks.transaction.mockImplementation((operations: Promise<unknown>[]) =>
    Promise.all(operations),
  );
});

describe("persistCandidates", () => {
  it("processes candidates in period order so an older one never closes the newer", async () => {
    const newer = an3Candidate("2026-09-08", "2026-10-05", "2026-W41:28d");
    const older = an3Candidate("2026-09-07", "2026-10-04", "2026-W40:28d");
    // Önce eski dönem: satır yok → create; sonra yeni dönem: eski OPEN → supersede.
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "new-1",
      status: "OPEN",
      severity: "WARN",
      dismissedAt: null,
      evidence: an3({ from: "2026-09-07", to: "2026-10-04" }),
      periodStart: new Date("2026-09-07T00:00:00.000Z"),
      occurrences: 1,
    });
    const result = await persistCandidates({
      link: LINK,
      candidates: [newer, older],
      mode: "live",
      now: NOW,
    });
    expect(result.created).toEqual(["new-1", "new-2"]);
    expect(result.superseded).toBe(1);
    const firstCreate = mocks.create.mock.calls[0]?.[0] as {
      data: { periodKey: string };
    };
    expect(firstCreate.data.periodKey).toBe("2026-W40:28d");
    const secondCreate = mocks.create.mock.calls[1]?.[0] as {
      data: { periodKey: string; previousId: string; occurrences: number };
    };
    expect(secondCreate.data).toMatchObject({
      periodKey: "2026-W41:28d",
      previousId: "new-1",
      occurrences: 2,
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "new-1", status: "OPEN" },
      data: { status: "SUPERSEDED", closedReason: "newer", closedAt: NOW },
    });
  });

  it("skips a stale candidate older than the latest row", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "row-9",
      status: "OPEN",
      severity: "WARN",
      dismissedAt: null,
      evidence: an3({ from: "2026-09-08", to: "2026-10-05" }),
      periodStart: new Date("2026-09-08T00:00:00.000Z"),
      occurrences: 3,
    });
    const result = await persistCandidates({
      link: LINK,
      candidates: [an3Candidate("2026-09-07", "2026-10-04", "2026-W40:28d")],
      mode: "live",
      now: NOW,
    });
    expect(result).toMatchObject({ created: [], stale: 1, superseded: 0 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("creates a new AN1 after a dismissed AN1 (event rule)", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "row-1",
      status: "DISMISSED",
      severity: "WARN",
      dismissedAt: new Date("2026-10-06T08:00:00.000Z"),
      evidence: an1Evidence("2026-10-04"),
      periodStart: new Date("2026-10-04T00:00:00.000Z"),
      occurrences: 1,
    });
    const result = await persistCandidates({
      link: LINK,
      candidates: [an1Candidate("2026-10-05")],
      mode: "live",
      now: NOW,
    });
    expect(result.created).toEqual(["new-1"]);
    const create = mocks.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    // Olay kuralı önceki satıra bağlanmaz.
    expect(create.data.previousId).toBeUndefined();
    expect(create.data).toMatchObject({
      ruleKey: "AN1",
      mode: "live",
      isMock: false,
      periodKey: "2026-10-05",
    });
  });

  it("retires an open shadow row with the same fingerprint and creates the live row", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "shadow-1",
      status: "OPEN",
      mode: "shadow",
    });
    const result = await persistCandidates({
      link: LINK,
      candidates: [an1Candidate("2026-10-05")],
      mode: "live",
      now: NOW,
    });
    expect(result).toMatchObject({ created: ["new-1"], superseded: 1 });
    const retire = mocks.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: { fingerprint: string; status: string; closedReason: string };
    };
    expect(retire.where).toEqual({
      id: "shadow-1",
      status: "OPEN",
      mode: "shadow",
    });
    expect(retire.data.status).toBe("SUPERSEDED");
    expect(retire.data.closedReason).toBe("shadow");
    expect(retire.data.fingerprint).toMatch(
      /^link-1:AN1:[0-9a-f]{16}:2026-10-05#shadow:shadow-1$/,
    );
    const create = mocks.create.mock.calls[0]?.[0] as {
      data: { fingerprint: string; mode: string };
    };
    expect(create.data.mode).toBe("live");
    expect(create.data.fingerprint).toMatch(
      /^link-1:AN1:[0-9a-f]{16}:2026-10-05$/,
    );
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("counts a unique violation as refreshed", async () => {
    mocks.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const result = await persistCandidates({
      link: LINK,
      candidates: [an1Candidate("2026-10-05")],
      mode: "shadow",
      now: NOW,
    });
    expect(result).toMatchObject({ created: [], refreshed: 1 });
  });

  it("refreshes an open row of the same mode", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "row-1",
      status: "OPEN",
      mode: "shadow",
    });
    const result = await persistCandidates({
      link: LINK,
      candidates: [an1Candidate("2026-10-05")],
      mode: "shadow",
      now: NOW,
    });
    expect(result.refreshed).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
