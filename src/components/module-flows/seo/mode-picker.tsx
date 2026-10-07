"use client";

import { SEO_MODES, type SeoMode } from "@/lib/module-flows/seo/state";
import { setSeoModeAction } from "@/server/actions/seo-mode-actions";

import { SEO_FLOW_COPY as COPY } from "./copy";
import { Field, serverButton, useSeoStepAction } from "./parts";

// SC-F6: Brief'in başındaki kip seçici (state.features.modes). Üç seçenek:
// makale yaz, var olan sayfayı tazele, yalnız başlık/açıklama düzelt. Seçim
// kartın kipini sunucuda değiştirir; kart yenilenince gövde kipe göre çizilir.

function isMode(value: string): value is SeoMode {
  return (SEO_MODES as readonly string[]).includes(value);
}

export function ModePicker({
  projectId,
  commandId,
  mode,
  blocked,
}: {
  projectId?: string;
  commandId?: string;
  mode: SeoMode;
  blocked: string | null;
}) {
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    server: (id, card) =>
      isMode(id)
        ? setSeoModeAction(card.projectId, card.commandId, id)
        : Promise.resolve({ ok: false as const, message: COPY.modeFailed }),
  });
  // Dokunulan kip, sunucu cevaplayana kadar seçili görünür.
  const shown: SeoMode = busyId && isMode(busyId) ? busyId : mode;

  return (
    <Field label={COPY.modesLabel}>
      <div
        role="radiogroup"
        aria-label={COPY.modesLabel}
        className="grid grid-cols-1 gap-1.5 sm:grid-cols-3"
      >
        {SEO_MODES.map((option) => {
          const selected = shown === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={Boolean(blocked) || busyId !== null}
              title={blocked ?? undefined}
              onClick={() => {
                if (option !== mode) {
                  onAct(serverButton(option, COPY.modes[option].label, "quiet", null));
                }
              }}
              className="flex min-h-12 flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                borderColor: selected ? "var(--ws-accent)" : "var(--ws-border)",
              }}
            >
              <span
                className="text-sm font-medium"
                style={{ color: "var(--ws-text)" }}
              >
                {COPY.modes[option].label}
              </span>
              <span
                className="text-xs leading-4"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.modes[option].hint}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-xs" style={{ color: "var(--destructive)" }}>
          {error}
        </p>
      ) : null}
    </Field>
  );
}
