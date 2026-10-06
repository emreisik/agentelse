import { describe, expect, it } from "vitest";

import { detectQueryLanguage } from "./query-language";

describe("detectQueryLanguage", () => {
  it("reads the script first", () => {
    expect(detectQueryLanguage("ќебапи скопје")).toBe("mk");
    expect(detectQueryLanguage("Љубов песни")).toBe("mk");
    expect(detectQueryLanguage("купить обувь")).toBe("ru");
    expect(detectQueryLanguage("ξενοδοχεία αθήνα")).toBe("el");
    expect(detectQueryLanguage("فنادق دبي")).toBe("ar");
  });

  it("tells Latin languages apart by letters and stopwords", () => {
    expect(detectQueryLanguage("nasıl yapılır")).toBe("tr");
    expect(detectQueryLanguage("kedi mama fiyat")).toBe("tr");
    expect(detectQueryLanguage("diş hekimi")).toBe("tr");
    expect(detectQueryLanguage("Straße sperrung")).toBe("de");
    expect(detectQueryLanguage("schuhe kaufen für kinder")).toBe("de");
    expect(detectQueryLanguage("how to tie a tie")).toBe("en");
    expect(detectQueryLanguage("dentist near me")).toBe("en");
    expect(detectQueryLanguage("nike air max")).toBeNull();
    expect(detectQueryLanguage("")).toBeNull();
  });
});
