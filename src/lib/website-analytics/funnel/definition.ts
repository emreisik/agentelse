import type {
  FunnelDefinition,
  FunnelStep,
  FunnelStepKind,
} from "./types";

// Huni tanımı doğrulaması (GA-F8). Saf modül.

export const FUNNEL_MIN_STEPS = 2;
export const FUNNEL_MAX_STEPS = 6;
export const FUNNEL_NAME_MAX = 60;
export const FUNNEL_STEP_NAME_MAX = 40;
export const FUNNEL_PATH_MAX = 200;
export const FUNNEL_MIN_DAYS = 7;
export const FUNNEL_MAX_DAYS = 90;
export const FUNNEL_PERIOD_OPTIONS = [7, 14, 28, 90] as const;

// GA4 olay adı: harfle başlar, harf/rakam/alt çizgi, en çok 40 karakter.
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// Kişisel veri koruması: sunucudaki google/pii.ts'in e-posta deseninin
// yerel kopyası (lib katmanı src/server içe aktaramaz; desen aynı kalmalı).
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export type FunnelValidation =
  | { ok: true; definition: FunnelDefinition }
  | { ok: false; message: string };

function fail(message: string): FunnelValidation {
  return { ok: false, message };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Sayfa yolu: "/" ile başlar, sorgu dizesi ya da parça içermez, boşluk
// içermez, e-posta içermez.
function pathProblem(value: string): string | null {
  if (!value.startsWith("/")) return "Page paths must start with /.";
  if (value.length > FUNNEL_PATH_MAX) return "A page path is too long.";
  if (/[?#]/.test(value)) {
    return "Page paths can't contain ? or #. Use the part before them.";
  }
  if (/\s/.test(value)) return "Page paths can't contain spaces.";
  if (EMAIL.test(value) || EMAIL.test(decoded(value))) {
    return "Page paths can't contain an email address.";
  }
  return null;
}

function validateStep(raw: unknown, index: number): FunnelStep | string {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const label = `Step ${index + 1}`;
  const name = text(record.name);
  const value = text(record.value);
  const kind: FunnelStepKind | null =
    record.kind === "event" || record.kind === "page" ? record.kind : null;
  if (!name) return `${label} needs a name.`;
  if (name.length > FUNNEL_STEP_NAME_MAX) {
    return `${label}: the name is too long (max ${FUNNEL_STEP_NAME_MAX}).`;
  }
  if (!kind) return `${label}: pick event or page.`;
  if (!value) {
    return kind === "event"
      ? `${label} needs an event name.`
      : `${label} needs a page path.`;
  }
  if (kind === "event") {
    if (!EVENT_NAME.test(value)) {
      return `${label}: event names use letters, numbers and underscores, and start with a letter.`;
    }
  } else {
    const problem = pathProblem(value);
    if (problem) return `${label}: ${problem}`;
  }
  return { name, kind, value };
}

// Ham girdiyi (form ya da JSON) doğrular ve temizlenmiş tanımı döner.
export function validateFunnelDefinition(input: unknown): FunnelValidation {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const name = text(record.name);
  if (!name) return fail("Give the funnel a name.");
  if (name.length > FUNNEL_NAME_MAX) {
    return fail(`The funnel name is too long (max ${FUNNEL_NAME_MAX}).`);
  }
  const periodDays = Number(record.periodDays);
  if (
    !Number.isInteger(periodDays) ||
    periodDays < FUNNEL_MIN_DAYS ||
    periodDays > FUNNEL_MAX_DAYS
  ) {
    return fail(
      `Pick a period between ${FUNNEL_MIN_DAYS} and ${FUNNEL_MAX_DAYS} days.`,
    );
  }
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  if (rawSteps.length < FUNNEL_MIN_STEPS || rawSteps.length > FUNNEL_MAX_STEPS) {
    return fail(
      `A funnel needs ${FUNNEL_MIN_STEPS} to ${FUNNEL_MAX_STEPS} steps.`,
    );
  }
  const steps: FunnelStep[] = [];
  for (const [index, raw] of rawSteps.entries()) {
    const step = validateStep(raw, index);
    if (typeof step === "string") return fail(step);
    steps.push(step);
  }
  const names = new Set(steps.map((step) => step.name.toLowerCase()));
  if (names.size !== steps.length) {
    return fail("Each step needs its own name.");
  }
  return {
    ok: true,
    definition: {
      name,
      isOpen: record.isOpen === true,
      periodDays,
      steps,
    },
  };
}

export type FunnelPreset = {
  key: "lead" | "shop";
  label: string;
  definition: FunnelDefinition;
};

// Hazır tanımlar (GA4'ün otomatik toplanan ve önerilen olay adlarıyla).
export const FUNNEL_PRESETS: readonly FunnelPreset[] = [
  {
    key: "lead",
    label: "Lead",
    definition: {
      name: "Lead funnel",
      isOpen: false,
      periodDays: 28,
      steps: [
        { name: "Visit", kind: "event", value: "page_view" },
        { name: "Started a form", kind: "event", value: "form_start" },
        { name: "Lead", kind: "event", value: "generate_lead" },
      ],
    },
  },
  {
    key: "shop",
    label: "Shop",
    definition: {
      name: "Shop funnel",
      isOpen: false,
      periodDays: 28,
      steps: [
        { name: "Viewed a product", kind: "event", value: "view_item" },
        { name: "Added to cart", kind: "event", value: "add_to_cart" },
        { name: "Started checkout", kind: "event", value: "begin_checkout" },
        { name: "Purchase", kind: "event", value: "purchase" },
      ],
    },
  },
];

export function funnelPreset(key: string): FunnelPreset | null {
  return FUNNEL_PRESETS.find((preset) => preset.key === key) ?? null;
}
