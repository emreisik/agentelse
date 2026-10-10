import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Self-signup and the free trial: a new workspace gets its trial AFTER the account exists,
// only for a registration that really succeeded, and never makes registration fail.

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  limited: vi.fn(),
  userFind: vi.fn(),
  workspaceFind: vi.fn(),
  transaction: vi.fn(),
  startSignupTrial: vi.fn(),
  hash: vi.fn(),
  order: [] as string[],
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("bcryptjs", () => ({ default: { hash: mocks.hash } }));
vi.mock("@/lib/auth", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.limited }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFind },
    workspace: { findUnique: mocks.workspaceFind },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/server/billing/subscription", () => ({
  startSignupTrial: mocks.startSignupTrial,
}));

const { registerAction } = await import("./auth-actions");

const INPUT = {
  name: "Ada",
  email: "ada@example.com",
  password: "long-enough-password",
  workspaceName: "Acme Studio",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.headers.mockResolvedValue(
    new Headers({ "x-forwarded-for": "1.2.3.4" }),
  );
  mocks.limited.mockReturnValue(false);
  mocks.userFind.mockResolvedValue(null);
  mocks.workspaceFind.mockResolvedValue(null);
  mocks.hash.mockResolvedValue("hashed");
  mocks.transaction.mockImplementation(
    async (run: (tx: unknown) => Promise<string>) => {
      const id = await run({
        workspace: { create: async () => ({ id: "ws_new" }) },
        user: { create: async () => ({ id: "user_new" }) },
        workspaceMember: { create: async () => ({}) },
      });
      mocks.order.push("transaction");
      return id;
    },
  );
  mocks.startSignupTrial.mockImplementation(async () => {
    mocks.order.push("trial");
    return { started: true, trialEndsAt: new Date() };
  });
});

describe("registerAction and the free trial", () => {
  it("starts the trial for the new workspace after the account exists", async () => {
    expect(await registerAction(INPUT)).toEqual({ ok: true });

    expect(mocks.startSignupTrial).toHaveBeenCalledTimes(1);
    expect(mocks.startSignupTrial).toHaveBeenCalledWith("ws_new");
    expect(mocks.order).toEqual(["transaction", "trial"]);
  });

  it("registration succeeds whether or not a trial was given", async () => {
    mocks.startSignupTrial.mockResolvedValue({
      started: false,
      reason: "BILLING_OFF",
    });

    expect(await registerAction(INPUT)).toEqual({ ok: true });
  });

  it("gives no trial to a registration that did not happen", async () => {
    // invalid form
    expect(
      await registerAction({ ...INPUT, email: "not-an-email" }),
    ).toMatchObject({
      ok: false,
    });
    // too many attempts
    mocks.limited.mockReturnValueOnce(true);
    expect(await registerAction(INPUT)).toMatchObject({ ok: false });
    // the email is taken (found up front, and lost in a race)
    mocks.userFind.mockResolvedValueOnce({ id: "u" });
    expect(await registerAction(INPUT)).toMatchObject({ ok: false });
    mocks.transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    expect(await registerAction(INPUT)).toMatchObject({ ok: false });

    expect(mocks.startSignupTrial).not.toHaveBeenCalled();
  });
});
