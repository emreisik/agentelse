import { beforeEach, describe, expect, it, vi } from "vitest";

// The two switches of guided setup: off by default, only the literal "true"
// turns them on, the paid step needs the master switch too, and the gates report
// what would make the paid run refuse (mock mode, no OpenAI key).

const env: Record<string, unknown> = {};
const isIntegrationConfigured = vi.fn();
vi.mock("@/lib/env", () => ({
  getEnv: () => env,
  isIntegrationConfigured,
}));
const isMockMode = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { isMockMode },
}));

const { discoveryCaps, discoveryGates, isGuidedSetupEnabled } = await import("./flag");

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, {
    GUIDED_SETUP: false,
    GUIDED_SETUP_DISCOVERY: "false",
    GUIDED_SETUP_DISCOVERY_CAPS: "",
  });
  isIntegrationConfigured.mockReturnValue(true);
  isMockMode.mockReturnValue(false);
});

describe("isGuidedSetupEnabled", () => {
  it("is off until it is turned on", () => {
    expect(isGuidedSetupEnabled()).toBe(false);

    env.GUIDED_SETUP = true;
    expect(isGuidedSetupEnabled()).toBe(true);
  });

  it("reads the environment at call time, not once at import", () => {
    expect(isGuidedSetupEnabled()).toBe(false);
    env.GUIDED_SETUP = true;
    expect(isGuidedSetupEnabled()).toBe(true);
    env.GUIDED_SETUP = false;
    expect(isGuidedSetupEnabled()).toBe(false);
  });
});

describe("discoveryGates", () => {
  it("is closed by default", () => {
    expect(discoveryGates("w1").enabled).toBe(false);
  });

  it("needs both switches: the paid step never runs on its own", () => {
    env.GUIDED_SETUP_DISCOVERY = "true";
    expect(discoveryGates("w1").enabled).toBe(false);

    env.GUIDED_SETUP = true;
    expect(discoveryGates("w1").enabled).toBe(true);
  });

  it("is closed again when only the master switch is on", () => {
    env.GUIDED_SETUP = true;

    expect(discoveryGates("w1").enabled).toBe(false);
  });

  it("reports mock reasoning mode, in which nothing AI-made may be applied", () => {
    isMockMode.mockReturnValue(true);

    expect(discoveryGates("w1").mock).toBe(true);
  });

  it("reports an OpenAI provider that has no key", () => {
    isIntegrationConfigured.mockReturnValue(false);

    expect(discoveryGates("w1").providerOk).toBe(false);
  });

  it("is happy with the OpenAI provider and a key", () => {
    expect(discoveryGates("w1")).toEqual({
      enabled: false,
      mock: false,
      providerOk: true,
    });
    expect(isIntegrationConfigured).toHaveBeenCalledWith("OPENAI");
  });
});

describe("discovery scope (G69)", () => {
  beforeEach(() => {
    env.GUIDED_SETUP = true;
  });

  it("opens every workspace for true", () => {
    env.GUIDED_SETUP_DISCOVERY = "true";
    expect(discoveryGates("w1").enabled).toBe(true);
    expect(discoveryGates("other").enabled).toBe(true);
  });

  it("opens only the listed workspaces for a csv", () => {
    env.GUIDED_SETUP_DISCOVERY = "w1, w2";
    expect(discoveryGates("w1").enabled).toBe(true);
    expect(discoveryGates("w2").enabled).toBe(true);
    expect(discoveryGates("w3").enabled).toBe(false);
  });

  it.each(["w1,,w2", "w1,bad id", "TRUE", "yes", "1", "w1;w2"])(
    "reads the typo %j as off, even for a listed workspace",
    (value) => {
      env.GUIDED_SETUP_DISCOVERY = value;
      expect(discoveryGates("w1").enabled).toBe(false);
    },
  );

  it("never opens without the master switch", () => {
    env.GUIDED_SETUP = false;
    env.GUIDED_SETUP_DISCOVERY = "true";
    expect(discoveryGates("w1").enabled).toBe(false);
    env.GUIDED_SETUP_DISCOVERY = "w1";
    expect(discoveryGates("w1").enabled).toBe(false);
  });

  it("reads the environment at call time", () => {
    env.GUIDED_SETUP_DISCOVERY = "w1";
    expect(discoveryGates("w1").enabled).toBe(true);
    env.GUIDED_SETUP_DISCOVERY = "w2";
    expect(discoveryGates("w1").enabled).toBe(false);
  });
});

describe("discoveryCaps (G54)", () => {
  const ceilings = { perUserPer24h: 5, perWorkspacePer24h: 10, globalPer24h: 20 };

  it("defaults to the ceilings", () => {
    expect(discoveryCaps()).toEqual(ceilings);
  });

  it("can lower each cap, and 0,0,0 pauses", () => {
    env.GUIDED_SETUP_DISCOVERY_CAPS = "2,3,4";
    expect(discoveryCaps()).toEqual({
      perUserPer24h: 2,
      perWorkspacePer24h: 3,
      globalPer24h: 4,
    });
    env.GUIDED_SETUP_DISCOVERY_CAPS = "0,0,0";
    expect(discoveryCaps()).toEqual({
      perUserPer24h: 0,
      perWorkspacePer24h: 0,
      globalPer24h: 0,
    });
  });

  it("can never raise a cap above its ceiling", () => {
    env.GUIDED_SETUP_DISCOVERY_CAPS = "50,100,200";
    expect(discoveryCaps()).toEqual(ceilings);
    env.GUIDED_SETUP_DISCOVERY_CAPS = "1,999,7";
    expect(discoveryCaps()).toEqual({
      perUserPer24h: 1,
      perWorkspacePer24h: 10,
      globalPer24h: 7,
    });
  });

  it.each(["abc", "1,2", "1,2,3,4", "-1,2,3", "1.5,2,3", "1000,2,3", "1,,3"])(
    "falls back to the ceilings for the bad value %j",
    (value) => {
      env.GUIDED_SETUP_DISCOVERY_CAPS = value;
      expect(discoveryCaps()).toEqual(ceilings);
    },
  );

  it("reads the environment at call time", () => {
    env.GUIDED_SETUP_DISCOVERY_CAPS = "1,1,1";
    expect(discoveryCaps().perUserPer24h).toBe(1);
    env.GUIDED_SETUP_DISCOVERY_CAPS = "";
    expect(discoveryCaps().perUserPer24h).toBe(5);
  });
});
