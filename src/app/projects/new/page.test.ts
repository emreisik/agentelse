import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnv = vi.fn();
vi.mock("@/lib/env", () => ({ getEnv }));

const requestHeaders = vi.fn();
const acceptLanguage = vi.fn();
vi.mock("next/headers", () => ({
  headers: async () => {
    requestHeaders();
    return { get: acceptLanguage };
  },
}));

const requireUser = vi.fn();
const requireWorkspaceMembership = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireWorkspaceMembership,
}));

const projectFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findFirst: projectFindFirst } },
}));

vi.mock("@/components/layout/app-shell", () => ({
  AppShell: function AppShell() {
    return null;
  },
}));
vi.mock("@/components/projects/new-project-wizard", () => ({
  NewProjectWizard: function NewProjectWizard() {
    return null;
  },
}));
vi.mock("@/components/projects/new-project-form", () => ({
  NewProjectForm: function NewProjectForm() {
    return null;
  },
}));

const { default: NewProjectPage } = await import("./page");
const { NewProjectWizard } = await import(
  "@/components/projects/new-project-wizard"
);
const { NewProjectForm } = await import(
  "@/components/projects/new-project-form"
);

// Finds the first element of a type in an unrendered React tree.
function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  const props = node.props as { children?: ReactNode };
  return find(props.children, type);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireWorkspaceMembership.mockResolvedValue({ workspaceId: "ws-1" });
  projectFindFirst.mockResolvedValue(null);
  acceptLanguage.mockReturnValue(null);
});

describe("/projects/new page", () => {
  it("renders the untouched four-step wizard with the flag off (G71)", async () => {
    getEnv.mockReturnValue({ GUIDED_SETUP: false });
    const tree = await NewProjectPage();
    expect(find(tree, NewProjectWizard)).not.toBeNull();
    expect(find(tree, NewProjectForm)).toBeNull();
    // Nothing of the guided path runs: no session read, no query, no headers.
    expect(requireUser).not.toHaveBeenCalled();
    expect(projectFindFirst).not.toHaveBeenCalled();
    expect(requestHeaders).not.toHaveBeenCalled();
  });

  it("renders the one-screen form with the flag on, seeded from the latest project", async () => {
    getEnv.mockReturnValue({ GUIDED_SETUP: true });
    projectFindFirst.mockResolvedValue({ language: "mk", country: "MK" });
    const tree = await NewProjectPage();
    expect(find(tree, NewProjectWizard)).toBeNull();
    expect(find(tree, NewProjectForm)?.props).toEqual({
      initialLocale: { country: "MK", language: "mk", source: "previous" },
    });
    expect(projectFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      orderBy: { createdAt: "desc" },
      select: { language: true, country: true },
    });
  });

  it("falls back to the browser language, then to nothing", async () => {
    getEnv.mockReturnValue({ GUIDED_SETUP: true });
    acceptLanguage.mockReturnValue("tr-TR,tr;q=0.9,en;q=0.8");
    let tree = await NewProjectPage();
    expect(find(tree, NewProjectForm)?.props).toEqual({
      initialLocale: { country: "TR", language: "tr", source: "browser" },
    });
    acceptLanguage.mockReturnValue("en-US,en;q=0.9");
    tree = await NewProjectPage();
    expect(find(tree, NewProjectForm)?.props).toEqual({ initialLocale: null });
  });
});
