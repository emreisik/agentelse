import { describe, expect, it } from "vitest";

import { isQuestionHeading } from "./questions";

// Bu dosyanın kanıtladığı (SC-F8 GEO8): "?" ya da en, tr, de, fr, es, it, nl,
// pt soru sözcüğüyle başlayan başlık sorudur; sıradan başlık değildir.

describe("isQuestionHeading", () => {
  it("accepts any heading with a question mark", () => {
    expect(isQuestionHeading("Pricing?")).toBe(true);
    expect(isQuestionHeading("Fiyat nedir ?")).toBe(true);
    expect(isQuestionHeading("¿Precio")).toBe(true);
  });

  it.each([
    ["en", "How do I reset my password"],
    ["en", "What is a widget"],
    ["en", "Can I cancel anytime"],
    ["tr", "Nasıl sipariş verilir"],
    ["tr", "NASIL ÇALIŞIR"],
    ["tr", "Ne kadar sürer teslimat"],
    ["de", "Wie funktioniert die Lieferung"],
    ["de", "Warum Bio wählen"],
    ["fr", "Comment commander en ligne"],
    ["fr", "Qu'est-ce que le bio"],
    ["fr", "Pourquoi choisir un abonnement"],
    ["es", "Cómo funciona el envío"],
    ["es", "Qué incluye el plan"],
    ["it", "Come funziona la spedizione"],
    ["it", "Perché scegliere il bio"],
    ["nl", "Hoe werkt de levering"],
    ["nl", "Waarom kiezen voor ons"],
    ["pt", "Como funciona a entrega"],
    ["pt", "Onde posso comprar"],
  ])("accepts a %s interrogative: %s", (_lang, heading) => {
    expect(isQuestionHeading(heading)).toBe(true);
  });

  it("ignores numbering and quotes before the question word", () => {
    expect(isQuestionHeading("1. How it works")).toBe(true);
    expect(isQuestionHeading("Q: Why us")).toBe(true);
  });

  it.each([
    "Our story",
    "Pricing and plans",
    "Contact us",
    "Hakkımızda",
    "Über uns",
    "Nos services",
    "Whatever",
    "How",
    "",
  ])("rejects %j", (heading) => {
    expect(isQuestionHeading(heading)).toBe(false);
  });
});
