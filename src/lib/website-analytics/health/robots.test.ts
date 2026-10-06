import { describe, expect, it } from "vitest";

import { parseRobots, robotsAllows } from "./robots";

// Bu dosyanın kanıtladığı: kendi kimliğimizin grubu '*' grubunu ezer; en
// uzun eşleşen kalıp kazanır, eşitlikte allow; `$` ve `*` çalışır; boş
// Disallow yok sayılır; boş ya da grupsuz metin her şeye izin verir.

const TOKEN = "AgentelseSiteCheck";

describe("robotsAllows", () => {
  it("uses the specific group over '*'", () => {
    const rules = parseRobots(
      [
        "User-agent: *",
        "Disallow: /",
        "",
        "User-agent: agentelsesitecheck",
        "Allow: /",
      ].join("\n"),
    );
    expect(robotsAllows(rules, TOKEN, "/")).toBe(true);
    expect(robotsAllows(rules, "OtherBot", "/")).toBe(false);
  });

  it("joins consecutive user-agent lines into one group", () => {
    const rules = parseRobots(
      [
        "user-agent: Googlebot",
        "User-Agent: AgentelseSiteCheck # biz",
        "Disallow: /private",
      ].join("\r\n"),
    );
    expect(rules.groups).toHaveLength(1);
    expect(robotsAllows(rules, TOKEN, "/private/page")).toBe(false);
    expect(robotsAllows(rules, TOKEN, "/public")).toBe(true);
  });

  it("lets the longest matching pattern win", () => {
    const rules = parseRobots(
      [
        "User-agent: *",
        "Disallow: /shop",
        "Allow: /shop/public",
        "Disallow: /shop/public/secret",
      ].join("\n"),
    );
    expect(robotsAllows(rules, TOKEN, "/shop/cart")).toBe(false);
    expect(robotsAllows(rules, TOKEN, "/shop/public/item")).toBe(true);
    expect(robotsAllows(rules, TOKEN, "/shop/public/secret/x")).toBe(false);
  });

  it("gives a tie to allow", () => {
    const rules = parseRobots(
      ["User-agent: *", "Disallow: /page", "Allow: /page"].join("\n"),
    );
    expect(robotsAllows(rules, TOKEN, "/page")).toBe(true);
  });

  it("supports '*' wildcards and the '$' anchor", () => {
    const rules = parseRobots(
      ["User-agent: *", "Disallow: /*.pdf$", "Disallow: /tmp*/draft"].join(
        "\n",
      ),
    );
    expect(robotsAllows(rules, TOKEN, "/files/a.pdf")).toBe(false);
    expect(robotsAllows(rules, TOKEN, "/files/a.pdf.html")).toBe(true);
    expect(robotsAllows(rules, TOKEN, "/tmp-1/draft/x")).toBe(false);
    expect(robotsAllows(rules, TOKEN, "/tmp-1/final")).toBe(true);
  });

  it("ignores an empty Disallow", () => {
    const rules = parseRobots(["User-agent: *", "Disallow:"].join("\n"));
    expect(robotsAllows(rules, TOKEN, "/")).toBe(true);
  });

  it("allows everything for empty text, rules without a group or no matching group", () => {
    expect(robotsAllows(parseRobots(""), TOKEN, "/")).toBe(true);
    expect(robotsAllows(parseRobots("Disallow: /\n"), TOKEN, "/")).toBe(true);
    expect(
      robotsAllows(
        parseRobots("User-agent: Googlebot\nDisallow: /"),
        TOKEN,
        "/",
      ),
    ).toBe(true);
    expect(() => parseRobots("\u0000::::\n\n#\nUser-agent\n")).not.toThrow();
  });
});

describe("robotsAllows pathological patterns", () => {
  it("matches many wildcards against a long path in linear time", () => {
    const rules = parseRobots(
      ["User-agent: *", `Disallow: /${"*a".repeat(40)}*b`].join("\n"),
    );
    const path = `/${"a".repeat(300)}`;
    const started = performance.now();
    expect(robotsAllows(rules, TOKEN, path)).toBe(true);
    expect(robotsAllows(rules, TOKEN, `${path}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
