import { beforeEach, describe, expect, it, vi } from "vitest";

import { isManagerInline } from "./roles";

// Motorun satır içi rol denetimi: yalnız OWNER/ADMIN yönetici sayılır;
// 'telegram:<id>' gibi sözde kullanıcılar sorgu yapılmadan reddedilir.

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: { workspaceMember: { findUnique } },
}));

beforeEach(() => {
  findUnique.mockReset();
});

describe("isManagerInline", () => {
  it.each(["OWNER", "ADMIN"])("treats %s as a manager", async (role) => {
    findUnique.mockResolvedValue({ role });
    await expect(isManagerInline("user-1", "ws-1")).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws-1", userId: "user-1" } },
      select: { role: true },
    });
  });

  it.each(["MEMBER", "VIEWER", "GUEST"])(
    "does not treat %s as a manager",
    async (role) => {
      findUnique.mockResolvedValue({ role });
      await expect(isManagerInline("user-1", "ws-1")).resolves.toBe(false);
    },
  );

  it("is false for a user that is not a member of the workspace", async () => {
    findUnique.mockResolvedValue(null);
    await expect(isManagerInline("user-1", "ws-1")).resolves.toBe(false);
  });

  it("denies a pseudo user id containing ':' without any query", async () => {
    await expect(isManagerInline("telegram:123", "ws-1")).resolves.toBe(false);
    await expect(isManagerInline("a:b", "ws-1")).resolves.toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
