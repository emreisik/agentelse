"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CardActions } from "@/components/works/card-actions";
import {
  SNIPPET_LIMITS,
  serpMeta,
  serpTitle,
  snippetChecks,
  type SnippetCheck,
} from "@/lib/module-flows/seo/snippet";
import type {
  SeoSnippet,
  SeoSnippetVariant,
  SeoState,
  SeoTarget,
} from "@/lib/module-flows/seo/state";
import type { CardButton } from "@/lib/works/card-action";
import { goToSeoStepAction } from "@/server/actions/seo-flow-actions";
import {
  chooseSnippetAction,
  suggestSnippetAction,
} from "@/server/actions/seo-mode-actions";

import { SEO_FLOW_COPY as COPY } from "./copy";
import {
  Field,
  RunNote,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";

// Başlık düzeltme kipinin Plan adımı (SC-F6, "Fix a snippet"): sayfanın bugünkü
// arama sonucu görünümü ve modelin üç başlık/açıklama seçeneği, her biri
// arama sonucu önizlemesi ve üç kontrol işaretiyle. Seçilen metin
// "Use this" öncesi düzenlenebilir; sayaçlar hedef uzunluğu gösterir.

const CHOOSE = "choose";
const AGAIN = "again";
const BACK = "goto:brief";

// ---- saf yardımcılar -------------------------------------------------------------

export type SnippetPreviewRow = {
  id: string;
  label: string;
  // Modelin açısı (bugünkü satırda yok).
  angle: string | null;
  host: string;
  // Arama sonucunda görünecek hali: sığmayan kısım "…" ile biter.
  title: string;
  meta: string;
  checks: { id: SnippetCheck["id"]; label: string; ok: boolean }[];
  current: boolean;
};

function hostOf(target: SeoTarget | undefined): string {
  if (!target) return COPY.snippetPreviewHost;
  try {
    return new URL(target.url).host.replace(/^www\./, "");
  } catch {
    return COPY.snippetPreviewHost;
  }
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

// Önizleme satırları: önce sayfanın bugünkü hali (başlığı varsa), sonra her
// seçenek. `variants` kartta düzenlenmiş metni de taşıyabilir.
export function snippetPreviewRows(input: {
  target: SeoTarget | undefined;
  variants: readonly SeoSnippetVariant[];
  keyword?: string | null;
}): SnippetPreviewRow[] {
  const { target, variants, keyword = null } = input;
  const host = hostOf(target);
  const rows: SnippetPreviewRow[] = [];
  if (target?.title) {
    rows.push({
      id: "current",
      label: COPY.snippetNow,
      angle: null,
      host,
      title: serpTitle(target.title),
      meta: serpMeta(target.metaDescription ?? ""),
      checks: [],
      current: true,
    });
  }
  variants.forEach((variant, index) => {
    rows.push({
      id: `variant-${index}`,
      label: COPY.snippetOption(index + 1),
      angle: variant.angle || null,
      host,
      title: serpTitle(variant.title),
      meta: serpMeta(variant.metaDescription),
      checks: snippetChecks(variant, keyword).map((check) => ({
        id: check.id,
        ok: check.ok,
        label: check.ok
          ? COPY.snippetCheck[check.id]
          : COPY.snippetCheckFail[check.id],
      })),
      current: false,
    });
  });
  return rows;
}

export type SnippetCounters = {
  title: { count: number; limit: number; over: boolean };
  meta: { count: number; limit: number; over: boolean };
  // "Use this" için: ikisi de dolu ve sunucunun üst sınırında ya da altında.
  usable: boolean;
  reason: string | null;
};

export function snippetCounters(input: {
  title: string;
  metaDescription: string;
}): SnippetCounters {
  const title = codePoints(input.title.trim());
  const meta = codePoints(input.metaDescription.trim());
  const empty = title === 0 || meta === 0;
  const tooLong =
    title > SNIPPET_LIMITS.titleMax || meta > SNIPPET_LIMITS.metaMax;
  return {
    title: {
      count: title,
      limit: SNIPPET_LIMITS.title,
      over: title > SNIPPET_LIMITS.title,
    },
    meta: {
      count: meta,
      limit: SNIPPET_LIMITS.meta,
      over: meta > SNIPPET_LIMITS.meta,
    },
    usable: !empty && !tooLong,
    reason: empty ? COPY.snippetEmpty : tooLong ? COPY.snippetTooLong : null,
  };
}

// ---- bileşenler ----------------------------------------------------------------

type Props = {
  projectId?: string;
  commandId?: string;
  state: SeoState;
  running: boolean;
  blocked: string | null;
  onMoving?: OnMoving;
};

export function SnippetStep(props: Props) {
  const { snippet } = props.state;
  if (props.running || !snippet) return <SnippetWaiting {...props} />;
  return (
    <SnippetEditor {...props} snippet={snippet} key={snippet.generatedAt} />
  );
}

// Öneriler hazırlanıyor ya da yanıt vermeden durdu.
function SnippetWaiting({
  projectId,
  commandId,
  state,
  running,
  blocked,
  onMoving,
}: Props) {
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [BACK]: "brief" },
    server: (id, card) =>
      id === BACK
        ? goToSeoStepAction(card.projectId, card.commandId, "brief")
        : suggestSnippetAction(card.projectId, card.commandId, {
            url: state.target?.url ?? "",
            language: state.brief?.language ?? "",
          }),
  });
  if (running || busyId === AGAIN) {
    return <RunNote text={COPY.snippetNote} />;
  }
  const canRetry = Boolean(state.target?.url && state.brief?.language);
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        {COPY.snippetStopped}
      </p>
      <CardActions
        buttons={[
          serverButton(
            AGAIN,
            COPY.tryAgain,
            "primary",
            blocked ?? (canRetry ? null : COPY.unavailable),
          ),
          serverButton(BACK, COPY.back, "quiet", blocked),
        ]}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}

function Serp({ row }: { row: SnippetPreviewRow }) {
  return (
    <div className="min-w-0 flex-1 space-y-0.5">
      <p className="flex items-center gap-2 text-[11px]">
        <span className="font-medium" style={{ color: "var(--ws-text-2)" }}>
          {row.label}
        </span>
        {row.angle ? (
          <span className="truncate" style={{ color: "var(--ws-text-3)" }}>
            {row.angle}
          </span>
        ) : null}
      </p>
      <p className="truncate text-[11px]" style={{ color: "var(--ws-text-2)" }}>
        {row.host}
      </p>
      <p
        className="text-[15px] leading-5 font-medium break-words"
        style={{ color: "var(--ws-accent)" }}
      >
        {row.title}
      </p>
      <p
        className="line-clamp-2 text-xs leading-5"
        style={{ color: "var(--ws-text-2)" }}
      >
        {row.meta}
      </p>
      {row.checks.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
          {row.checks.map((check) => (
            <li
              key={check.id}
              className="flex items-center gap-1 text-[11px]"
              style={{
                color: check.ok ? "var(--ws-text-2)" : "var(--ws-pending)",
              }}
            >
              {check.ok ? (
                <CircleCheck aria-hidden="true" className="size-3 shrink-0" />
              ) : (
                <CircleAlert aria-hidden="true" className="size-3 shrink-0" />
              )}
              {check.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Counter({
  count,
  limit,
  over,
}: {
  count: number;
  limit: number;
  over: boolean;
}) {
  return (
    <span
      className="text-[11px] tabular-nums"
      style={{ color: over ? "var(--ws-pending)" : "var(--ws-text-3)" }}
    >
      {COPY.snippetCounter(count, limit)}
    </span>
  );
}

function SnippetEditor({
  projectId,
  commandId,
  state,
  blocked,
  onMoving,
  snippet,
}: Props & { snippet: SeoSnippet }) {
  const ids = useId();
  const { target, brief } = state;
  const [selected, setSelected] = useState(snippet.chosen ?? 0);
  // Düzenlenen metin: seçilen seçeneğin kendi metninden başlar; kaydedilmiş
  // düzenleme yalnız seçili olan seçeneğe aittir.
  const [texts, setTexts] = useState(() =>
    snippet.variants.map((variant, index) =>
      index === snippet.chosen && snippet.edited
        ? snippet.edited
        : { title: variant.title, metaDescription: variant.metaDescription },
    ),
  );
  const text = texts[selected] ?? { title: "", metaDescription: "" };
  const counters = snippetCounters(text);

  const shown = snippet.variants.map((variant, index) => ({
    ...variant,
    ...(texts[index] ?? {}),
  }));
  const rows = snippetPreviewRows({ target, variants: shown });
  const canSuggest = Boolean(target?.url && brief?.language);

  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [CHOOSE]: "deliver", [BACK]: "brief" },
    server: (id, card) =>
      id === CHOOSE
        ? chooseSnippetAction(card.projectId, card.commandId, {
            index: selected,
            edited: {
              title: text.title.trim(),
              metaDescription: text.metaDescription.trim(),
            },
          })
        : id === AGAIN
          ? suggestSnippetAction(card.projectId, card.commandId, {
              url: target?.url ?? "",
              language: brief?.language ?? "",
            })
          : goToSeoStepAction(card.projectId, card.commandId, "brief"),
  });
  const suggesting = busyId === AGAIN;

  const buttons: CardButton[] = [
    serverButton(CHOOSE, COPY.useThis, "primary", blocked ?? counters.reason),
    serverButton(
      AGAIN,
      suggesting ? COPY.suggesting : COPY.suggestAgain,
      "secondary",
      blocked ?? (canSuggest ? null : COPY.unavailable),
    ),
    serverButton(BACK, COPY.back, "quiet", blocked),
  ];

  const current = rows.find((row) => row.current);
  const options = rows.filter((row) => !row.current);

  return (
    <div className="space-y-4">
      <fieldset disabled={busyId !== null} className="space-y-4">
        {current ? (
          <div
            className="flex rounded-xl border px-3 py-2.5"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <Serp row={current} />
          </div>
        ) : null}

        <fieldset className="space-y-1.5">
          <legend className="sr-only">{COPY.suggestTitles}</legend>
          {options.map((row, index) => (
            <label
              key={row.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors hover:bg-[var(--ws-hover)]"
              style={{
                borderColor:
                  selected === index ? "var(--ws-accent)" : "var(--ws-border)",
              }}
            >
              <input
                type="radio"
                name={`${ids}-variant`}
                checked={selected === index}
                onChange={() => setSelected(index)}
                className="mt-1 size-3.5 shrink-0"
                style={{ accentColor: "var(--ws-accent)" }}
              />
              <Serp row={row} />
            </label>
          ))}
        </fieldset>

        <div className="space-y-3">
          <Field
            label={COPY.snippetTitleLabel}
            htmlFor={`${ids}-title`}
            aside={<Counter {...counters.title} />}
          >
            <Input
              id={`${ids}-title`}
              value={text.title}
              maxLength={SNIPPET_LIMITS.titleMax}
              onChange={(event) => {
                const title = event.target.value;
                setTexts((list) =>
                  list.map((item, index) =>
                    index === selected ? { ...item, title } : item,
                  ),
                );
              }}
            />
          </Field>
          <Field
            label={COPY.snippetMetaLabel}
            htmlFor={`${ids}-meta`}
            aside={<Counter {...counters.meta} />}
          >
            <Textarea
              id={`${ids}-meta`}
              value={text.metaDescription}
              rows={3}
              maxLength={SNIPPET_LIMITS.metaMax}
              onChange={(event) => {
                const metaDescription = event.target.value;
                setTexts((list) =>
                  list.map((item, index) =>
                    index === selected ? { ...item, metaDescription } : item,
                  ),
                );
              }}
            />
          </Field>
        </div>
      </fieldset>

      {suggesting ? <RunNote text={COPY.snippetNote} /> : null}
      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}
