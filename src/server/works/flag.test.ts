import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  WORKS_UI: false,
  MODULES_UI: false,
  CHAT_ENGINE: "legacy" as "agent" | "legacy",
}));
vi.mock("@/lib/env", () => ({ getEnv: () => env }));

const { isModulesEnabled, isWorksEnabled } = await import("./flag");

beforeEach(() => {
  env.WORKS_UI = true;
  env.MODULES_UI = true;
  env.CHAT_ENGINE = "agent";
});

describe("isWorksEnabled", () => {
  it("is on with WORKS_UI under the agent engine only", () => {
    expect(isWorksEnabled()).toBe(true);
    env.CHAT_ENGINE = "legacy";
    expect(isWorksEnabled()).toBe(false);
    env.CHAT_ENGINE = "agent";
    env.WORKS_UI = false;
    expect(isWorksEnabled()).toBe(false);
  });
});

describe("isModulesEnabled", () => {
  it("is on with MODULES_UI while Works is on", () => {
    expect(isModulesEnabled()).toBe(true);
  });

  it("is off without MODULES_UI", () => {
    env.MODULES_UI = false;
    expect(isModulesEnabled()).toBe(false);
  });

  it("rides on Works: MODULES_UI alone changes nothing", () => {
    env.WORKS_UI = false;
    expect(isModulesEnabled()).toBe(false);
    env.WORKS_UI = true;
    env.CHAT_ENGINE = "legacy";
    expect(isModulesEnabled()).toBe(false);
  });

  it("is read at call time, not cached", () => {
    expect(isModulesEnabled()).toBe(true);
    env.MODULES_UI = false;
    expect(isModulesEnabled()).toBe(false);
    env.MODULES_UI = true;
    expect(isModulesEnabled()).toBe(true);
  });
});
