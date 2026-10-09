import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

// The ledger is faked so each test can make it misbehave in one precise way: a
// connection that drops after the commit, an error answer to a settle, a hold that
// comes back dead on a redelivery. A healthy ledger against a real database is
// covered by operation.integration.test.ts.
vi.mock("./ledger", () => ({
  reserveUsage: vi.fn(),
  settleUsage: vi.fn(),
  releaseUsage: vi.fn(),
}));

import { AgentelseError } from "@/server/security/errors";

import {
  releaseUsage,
  reserveUsage,
  settleUsage,
  type ReleaseResult,
  type ReserveResult,
  type SettleResult,
} from "./ledger";
import { beginOperation, type OperationSpec } from "./operation";
import { QuotaExceededError, isQuotaError } from "./quota-errors";

const B = (value: number) => BigInt(value);
const NOW = new Date();

const reserveMock = vi.mocked(reserveUsage);
const settleMock = vi.mocked(settleUsage);
const releaseMock = vi.mocked(releaseUsage);

// operationId "exec:job-1" + attemptToken "evt.1"; a dead key is replaced by the
// next one, `~1`, `~2` ...
const KEY = "exec:job-1#evt.1";
const NEXT_KEY = "exec:job-1#evt.1~1";
// One attempt can use the base key and MAX_KEY_REROLLS (3) re-rolls of it. Pinned
// on purpose: a loop bound that is off by one must not go unnoticed, and a change
// of the tuning should be a deliberate edit here.
const KEYS_PER_ATTEMPT = 4;

const taken = (reservationKey: string): ReserveResult => ({
  ok: true,
  kind: "RESERVED",
  reservationKey,
  fromPeriod: B(1),
  fromExtra: B(0),
});
const existing = (
  reservationKey: string,
  status: "RESERVED" | "SETTLED" | "RELEASED",
): ReserveResult => ({
  ok: true,
  kind: "REUSED",
  reservationKey,
  status,
  amountMismatch: false,
});
const ledgerFault: ReserveResult = { ok: false, reason: "ERROR" };
const noRoom: ReserveResult = {
  ok: false,
  reason: "INSUFFICIENT",
  available: B(0),
  resetsAt: null,
};

const settled: SettleResult = {
  status: "SETTLED",
  chargedPeriod: B(1),
  chargedExtra: B(0),
  overrun: B(0),
};
const released: ReleaseResult = {
  status: "RELEASED",
  releasedPeriod: B(1),
  releasedExtra: B(0),
};

function spec(
  reserve: OperationSpec["reserve"],
  overrides: Partial<OperationSpec> = {},
): OperationSpec {
  return {
    workspaceId: "ws_1",
    operationId: "exec:job-1",
    attemptToken: "evt.1",
    reserve,
    now: NOW,
    ...overrides,
  };
}

type Op = Awaited<ReturnType<typeof beginOperation>>;

function drawn(op: Op, images = 1) {
  op.meter.add({
    callId: randomUUID(),
    kind: "IMAGE",
    costMicros: B(80_000),
    success: true,
    units: images,
  });
}

function spent(op: Op, micros: number) {
  op.meter.add({
    callId: randomUUID(),
    kind: "TEXT",
    costMicros: B(micros),
    success: true,
  });
}

const keysAsked = () =>
  reserveMock.mock.calls.map(([input]) => input.reservationKey);
const releasedHolds = () =>
  releaseMock.mock.calls.map(([ref]) => `${ref.unit}:${ref.reservationKey}`);

// An operation that holds one picture right, ready to be finished.
async function holdingOnePicture(): Promise<Op> {
  reserveMock.mockImplementation(async (input) => taken(input.reservationKey));
  const op = await beginOperation(spec({ IMAGE: 1 }));
  drawn(op, 1);
  return op;
}

describe("operation lifecycle against a faulty ledger", () => {
  beforeEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    reserveMock.mockReset();
    settleMock.mockReset();
    releaseMock.mockReset();
    // A call nobody planned for is a bug in the test, not a silent success.
    reserveMock.mockImplementation(async () => {
      throw new Error("unplanned reserveUsage call");
    });
    settleMock.mockResolvedValue(settled);
    releaseMock.mockResolvedValue(released);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("a reserve that fails inside the ledger", () => {
    it("returns the key it may already have written, then reports the ledger as unavailable", async () => {
      // The connection can drop AFTER the commit: the row may exist although the
      // answer is an error, and nothing else would ever free it before its ttl.
      reserveMock.mockResolvedValueOnce(ledgerFault);

      const error = await beginOperation(spec({ IMAGE: 1 })).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AgentelseError);
      expect(error).toMatchObject({
        code: "BILLING_UNAVAILABLE",
        retryable: true,
      });
      expect(isQuotaError(error)).toBe(false);
      expect(reserveMock).toHaveBeenCalledTimes(1);
      expect(releaseMock).toHaveBeenCalledTimes(1);
      expect(releaseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws_1",
          unit: "IMAGE",
          reservationKey: KEY,
        }),
      );
    });

    it("also returns what it already holds for the other unit", async () => {
      reserveMock.mockImplementation(async (input) =>
        input.unit === "IMAGE" ? taken(input.reservationKey) : ledgerFault,
      );

      await expect(
        beginOperation(spec({ IMAGE: 1, AI_MICROS: B(90_000) })),
      ).rejects.toMatchObject({ code: "BILLING_UNAVAILABLE" });

      expect([...releasedHolds()].sort()).toEqual([
        `AI_MICROS:${KEY}`,
        `IMAGE:${KEY}`,
      ]);
    });

    it("returns the key of the try that failed, not the used-up one it started from", async () => {
      // A redelivery: the first key is used up, so the next one is written just as
      // the connection drops. The give-back has to name that next key; naming the
      // first one would leave the new hold standing until its ttl.
      reserveMock.mockImplementation(async (input) =>
        input.reservationKey === KEY
          ? existing(input.reservationKey, "SETTLED")
          : ledgerFault,
      );

      await expect(beginOperation(spec({ IMAGE: 1 }))).rejects.toMatchObject({
        code: "BILLING_UNAVAILABLE",
      });

      expect(keysAsked()).toEqual([KEY, NEXT_KEY]);
      expect(releasedHolds()).toEqual([`IMAGE:${NEXT_KEY}`]);
    });
  });

  describe("a settle that fails inside the ledger", () => {
    it("is tried again and the hold still ends settled", async () => {
      const op = await holdingOnePicture();
      settleMock
        .mockResolvedValueOnce({ status: "ERROR" })
        .mockResolvedValueOnce({ status: "ERROR" })
        .mockResolvedValueOnce(settled);

      await op.finish("delivered");

      expect(settleMock).toHaveBeenCalledTimes(3);
      for (const [ref, actual] of settleMock.mock.calls) {
        expect(ref).toMatchObject({
          workspaceId: "ws_1",
          unit: "IMAGE",
          reservationKey: KEY,
        });
        expect(actual).toBe(B(1));
      }
      // Settled on the third try: nothing was handed back instead.
      expect(releaseMock).not.toHaveBeenCalled();
      expect(op.meter.closed).toBe(true);
    });

    it("gives up after three tries without throwing: the result is already delivered", async () => {
      const op = await holdingOnePicture();
      settleMock.mockResolvedValue({ status: "ERROR" });

      await expect(op.finish("delivered")).resolves.toBeUndefined();

      expect(settleMock).toHaveBeenCalledTimes(3);
      expect(op.meter.closed).toBe(true);
    });

    it("retries a release that fails inside the ledger the same way", async () => {
      const op = await holdingOnePicture();
      releaseMock
        .mockResolvedValueOnce({ status: "ERROR" })
        .mockResolvedValueOnce({ status: "ERROR" })
        .mockResolvedValueOnce(released);

      await op.finish("aborted");

      expect(releaseMock).toHaveBeenCalledTimes(3);
      expect(settleMock).not.toHaveBeenCalled();
    });

    it.each([
      ["SETTLED", settled],
      ["ALREADY_SETTLED", { status: "ALREADY_SETTLED", settledAmount: B(1) }],
      ["NOT_FOUND", { status: "NOT_FOUND" }],
    ] as const)(
      "does not try again after a definite answer (%s)",
      async (_, answer) => {
        const op = await holdingOnePicture();
        settleMock.mockResolvedValue(answer);

        await op.finish("delivered");

        expect(settleMock).toHaveBeenCalledTimes(1);
      },
    );

    it("still returns normally when the ledger throws instead of answering", async () => {
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const op = await holdingOnePicture();
      settleMock.mockRejectedValue(new Error("connection reset"));

      await expect(op.finish("delivered")).resolves.toBeUndefined();

      expect(log).toHaveBeenCalledWith(
        "[billing] operation finish failed:",
        "Error",
      );
      expect(op.meter.closed).toBe(true);
    });
  });

  describe("a hold that already exists when the work is delivered again", () => {
    it.each(["RELEASED", "SETTLED"] as const)(
      "is not taken over when it is %s: the next key is tried",
      async (status) => {
        reserveMock.mockImplementation(async (input) =>
          input.reservationKey === KEY
            ? existing(input.reservationKey, status)
            : taken(input.reservationKey),
        );

        const op = await beginOperation(spec({ IMAGE: 1 }));

        expect(keysAsked()).toEqual([KEY, NEXT_KEY]);
        expect(op.holdsReservation).toBe(true);
        // The hold it ended up with is its own; the dead key is never touched.
        await op.abandon();
        expect(releasedHolds()).toEqual([`IMAGE:${NEXT_KEY}`]);
      },
    );

    it("is taken over when it is still RESERVED, and abandoning does not give it back", async () => {
      reserveMock.mockImplementation(async (input) =>
        existing(input.reservationKey, "RESERVED"),
      );

      const op = await beginOperation(spec({ IMAGE: 1 }));

      expect(keysAsked()).toEqual([KEY]);
      expect(op.holdsReservation).toBe(true);
      expect(op.meter.covered).toBe(true);
      // Not this call's own hold: the run that made it is still counting on it.
      await op.abandon();
      expect(releaseMock).not.toHaveBeenCalled();
    });

    it("settles the hold it took over once the work is delivered", async () => {
      reserveMock.mockImplementation(async (input) =>
        existing(input.reservationKey, "RESERVED"),
      );
      const op = await beginOperation(spec({ IMAGE: 1 }));
      drawn(op, 1);

      await op.finish("delivered");

      expect(settleMock).toHaveBeenCalledTimes(1);
      expect(settleMock).toHaveBeenCalledWith(
        expect.objectContaining({ unit: "IMAGE", reservationKey: KEY }),
        B(1),
      );
    });

    it("does not give a taken-over hold back when the other unit is refused", async () => {
      reserveMock.mockImplementation(async (input) =>
        input.unit === "IMAGE"
          ? existing(input.reservationKey, "RESERVED")
          : noRoom,
      );

      await expect(
        beginOperation(spec({ IMAGE: 1, AI_MICROS: B(90_000) })),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      expect(releaseMock).not.toHaveBeenCalled();
    });

    it("gives back the re-rolled key it holds for one unit when the other unit is refused", async () => {
      reserveMock.mockImplementation(async (input) => {
        if (input.unit === "AI_MICROS") return noRoom;
        return input.reservationKey === KEY
          ? existing(input.reservationKey, "SETTLED")
          : taken(input.reservationKey);
      });

      await expect(
        beginOperation(spec({ IMAGE: 1, AI_MICROS: B(90_000) })),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      // The hold it owns is the re-rolled one; the used-up key is never touched.
      expect(releasedHolds()).toEqual([`IMAGE:${NEXT_KEY}`]);
    });

    it("gives back only the hold it created when it also took one over", async () => {
      // The run that died got as far as the picture right and no further: the
      // picture hold is taken over, the AI hold is new.
      reserveMock.mockImplementation(async (input) =>
        input.unit === "IMAGE"
          ? existing(input.reservationKey, "RESERVED")
          : taken(input.reservationKey),
      );
      const op = await beginOperation(spec({ IMAGE: 1, AI_MICROS: B(90_000) }));

      await op.abandon();

      expect(releasedHolds()).toEqual([`AI_MICROS:${KEY}`]);
    });
  });

  describe("when every key of the attempt is already used up", () => {
    // Dead holds all the way down. A bound stops a runaway loop from hanging the
    // suite: it would end here as a failure instead.
    function everyKeyDead(status: "SETTLED" | "RELEASED") {
      reserveMock.mockImplementation(async (input) => {
        if (reserveMock.mock.calls.length > 10) {
          throw new Error("the reroll loop does not stop");
        }
        return existing(input.reservationKey, status);
      });
    }

    it("fails as an ordinary error that counts as an attempt, not as a ledger outage", async () => {
      everyKeyDead("SETTLED");

      const error = await beginOperation(spec({ IMAGE: 1 })).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AgentelseError);
      expect(error).toMatchObject({
        code: "INVALID_STATE_TRANSITION",
        retryable: false,
      });
      // The worker waits BILLING_UNAVAILABLE out for free and a quota error parks
      // the job: this must be neither, or the job loops for ever.
      expect((error as AgentelseError).code).not.toBe("BILLING_UNAVAILABLE");
      expect(isQuotaError(error)).toBe(false);

      // Every key of the attempt was tried once, in order, and no more than that.
      expect(keysAsked()).toEqual(
        Array.from({ length: KEYS_PER_ATTEMPT }, (_, roll) =>
          roll === 0 ? KEY : `${KEY}~${roll}`,
        ),
      );
      // Nothing was held, so nothing is given back.
      expect(releaseMock).not.toHaveBeenCalled();
    });

    it("ends the same way when the dead holds were released", async () => {
      everyKeyDead("RELEASED");
      await expect(beginOperation(spec({ IMAGE: 1 }))).rejects.toMatchObject({
        code: "INVALID_STATE_TRANSITION",
      });
    });

    it("gives back what it already holds for the other unit", async () => {
      reserveMock.mockImplementation(async (input) =>
        input.unit === "IMAGE"
          ? taken(input.reservationKey)
          : existing(input.reservationKey, "RELEASED"),
      );

      await expect(
        beginOperation(spec({ IMAGE: 1, AI_MICROS: B(90_000) })),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

      expect(releasedHolds()).toEqual([`IMAGE:${KEY}`]);
    });
  });

  describe("finish", () => {
    it("pending settles nothing and leaves the meter open for later calls", async () => {
      const op = await holdingOnePicture();

      await op.finish("pending");

      expect(settleMock).not.toHaveBeenCalled();
      expect(releaseMock).not.toHaveBeenCalled();
      expect(op.meter.closed).toBe(false);
      // A call that lands afterwards still counts as this operation's own spend.
      const before = op.meter.costMicros;
      spent(op, 5_000);
      expect(op.meter.costMicros).toBe(before + B(5_000));
      expect(op.meter.lateMicros).toBe(B(0));
    });

    it("settles once however often, and in whatever order, it is called", async () => {
      const op = await holdingOnePicture();

      await Promise.all([op.finish("delivered"), op.finish("delivered")]);
      await op.finish("aborted");
      await op.abandon();

      expect(settleMock).toHaveBeenCalledTimes(1);
      expect(settleMock).toHaveBeenCalledWith(
        expect.objectContaining({ unit: "IMAGE", reservationKey: KEY }),
        B(1),
      );
      expect(releaseMock).not.toHaveBeenCalled();
    });
  });

  describe("the text-only charge", () => {
    it("is reserved and settled on the operation's own clock", async () => {
      reserveMock.mockImplementation(async (input) =>
        taken(input.reservationKey),
      );
      const op = await beginOperation(spec({ IMAGE: 1 }, { ttlMs: 5_000 }));
      spent(op, 20_000); // the text step ran, no picture came out

      await op.finish("delivered");

      const textHold = reserveMock.mock.calls
        .map(([input]) => input)
        .find((input) => input.unit === "AI_MICROS");
      expect(textHold).toMatchObject({
        workspaceId: "ws_1",
        unit: "AI_MICROS",
        amount: B(20_000),
        reservationKey: `${KEY}~text`,
        operationId: "exec:job-1",
        ttlMs: 5_000,
      });
      // The wall clock is not the operation's clock: it would find a plan that
      // ended, or a window that has not begun, when the work ran in another one.
      expect(textHold?.now).toBe(NOW);
      expect(settleMock).toHaveBeenCalledWith(
        expect.objectContaining({
          unit: "AI_MICROS",
          reservationKey: `${KEY}~text`,
        }),
        B(20_000),
      );
    });

    it("is not made when nothing was spent on the text", async () => {
      reserveMock.mockImplementation(async (input) =>
        taken(input.reservationKey),
      );
      const op = await beginOperation(spec({ IMAGE: 1 }));

      await op.finish("delivered");

      // Only the picture right was ever asked for: no hold for text that cost nothing.
      expect(keysAsked()).toEqual([KEY]);
    });

    it.each(["RESERVED", "SETTLED"] as const)(
      "does not settle a text hold that already exists (%s): it is not this call's",
      async (status) => {
        reserveMock.mockImplementation(async (input) =>
          input.reservationKey === `${KEY}~text`
            ? existing(input.reservationKey, status)
            : taken(input.reservationKey),
        );
        const op = await beginOperation(spec({ IMAGE: 1 }));
        spent(op, 20_000);

        await op.finish("delivered");

        expect(keysAsked()).toContain(`${KEY}~text`);
        expect(
          settleMock.mock.calls.map(([ref]) => ref.reservationKey),
        ).not.toContain(`${KEY}~text`);
      },
    );
  });
});
