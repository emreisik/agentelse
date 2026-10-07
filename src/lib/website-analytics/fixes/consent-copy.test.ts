import { describe, expect, it } from "vitest";

import { GA_EDIT_ERROR_MESSAGES, gaEditStartHref } from "./consent-copy";

// Bu dosyanın kanıtladığı: ikinci onayın hata metinleri İngilizce ve dolu,
// başlatma adresi tam olarak start rotasının beklediği biçimde.

describe("GA edit consent copy", () => {
  it("has a non-empty English sentence for every error code", () => {
    expect(Object.keys(GA_EDIT_ERROR_MESSAGES).sort()).toEqual([
      "edit_account_mismatch",
      "edit_connect_first",
      "edit_manager_only",
      "edit_not_available",
      "edit_scope_missing",
    ]);
    for (const message of Object.values(GA_EDIT_ERROR_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message).toMatch(/^[A-Z]/);
      expect(message).toMatch(/[.]$/);
    }
  });

  it("builds the exact start link", () => {
    expect(gaEditStartHref("proj-1")).toBe(
      "/api/integrations/google/start?projectId=proj-1&service=analytics&upgrade=edit",
    );
  });
});
