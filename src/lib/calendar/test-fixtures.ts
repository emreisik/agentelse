// Takvim testlerinin ortak örnek verisi (üretim koduna girmez).

import { sourceOf } from "./source";
import type { CalendarItem, CalendarPayload, ItemFacts } from "./types";

export function facts(overrides: Partial<ItemFacts> = {}): ItemFacts {
  return {
    status: "APPROVED",
    hasContent: true,
    platform: "INSTAGRAM",
    channel: "instagram",
    formatKey: "instagram.post",
    connected: true,
    task: null,
    ...overrides,
  };
}

export function item(
  overrides: Partial<CalendarItem> = {},
  factOverrides: Partial<ItemFacts> = {},
): CalendarItem {
  return {
    id: "c1",
    title: "Autumn launch",
    label: "Instagram · Post",
    source: sourceOf("instagram", null),
    glyph: "image",
    scheduledFor: "2026-10-07T07:00:00.000Z",
    localDay: "2026-10-07",
    localTime: "10:00",
    stage: "scheduled",
    reason: null,
    overdue: false,
    movable: true,
    assetId: null,
    preview: null,
    publishedAt: null,
    postId: null,
    facts: facts(factOverrides),
    ...overrides,
  };
}

export function payload(
  items: CalendarItem[],
  overrides: Partial<CalendarPayload> = {},
): CalendarPayload {
  return {
    items,
    connections: [],
    scheduleEnabled: true,
    loadedAt: Date.parse("2026-10-03T12:00:00Z"),
    ...overrides,
  };
}
