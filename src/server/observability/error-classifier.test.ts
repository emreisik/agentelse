import { describe, expect, it } from "vitest";

import {
  classifyError,
  isAutoRecoverable,
} from "@/server/observability/error-classifier";

describe("classifyError", () => {
  it("bakiye hatasını yeniden denenmeyecek şekilde sınıflandırır", () => {
    const result = classifyError(
      '400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
    );
    expect(result.category).toBe("BILLING");
    expect(result.strategy).toBe("NEEDS_CONFIG");
    expect(result.degradesProvider).toBe(true);
    expect(isAutoRecoverable(result)).toBe(false);
  });

  it("hız sınırını soğuma sonrası yeniden denenecek olarak işaretler", () => {
    const result = classifyError("429 Too Many Requests — rate_limit_error");
    expect(result.category).toBe("RATE_LIMIT");
    expect(isAutoRecoverable(result)).toBe(true);
    expect(result.degradesProvider).toBe(true);
  });

  it("zaman aşımını sağlayıcıyı bozmadan yeniden denenebilir sayar", () => {
    const result = classifyError("aborted");
    expect(result.category).toBe("TIMEOUT");
    expect(isAutoRecoverable(result)).toBe(true);
    expect(result.degradesProvider).toBe(false);
  });

  it("bilinmeyen ajan kimliğini yapılandırma sorunu olarak ayırır", () => {
    const result = classifyError(
      'Error: Unknown agent id "web-health-public_research".',
    );
    expect(result.category).toBe("CONFIGURATION");
    expect(isAutoRecoverable(result)).toBe(false);
  });

  it("sağlayıcı yokluğunu entegrasyon eksiği olarak sınıflandırır", () => {
    const result = classifyError(
      "No execution provider available for capability SIGNAL_SCAN",
    );
    expect(result.category).toBe("PROVIDER_UNAVAILABLE");
    expect(result.degradesProvider).toBe(false);
  });

  it("şema ihlalini yeniden denenebilir sayar", () => {
    const result = classifyError(
      "openclaw agent --json did not return the confirmed schema",
    );
    expect(result.category).toBe("INVALID_RESULT");
    expect(isAutoRecoverable(result)).toBe(true);
  });

  it("boş ve tanınmayan mesajlar insan incelemesine düşer", () => {
    expect(classifyError(null).category).toBe("UNKNOWN");
    expect(classifyError("beklenmedik bir şey oldu").strategy).toBe(
      "NEEDS_HUMAN",
    );
  });

  it("bakiye kuralı hız sınırı kuralından önce eşleşir", () => {
    // Her iki anahtar kelimeyi de içeren mesajda sıralama belirleyicidir:
    // bakiye sorunu beklemekle çözülmez, yanlış sınıflandırma sonsuz
    // yeniden deneme döngüsü yaratır.
    const result = classifyError(
      "quota exceeded — too many requests for this billing period",
    );
    expect(result.category).toBe("BILLING");
  });
});
