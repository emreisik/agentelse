"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import {
  startTransition,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CardActions } from "@/components/works/card-actions";
import { SEO_LANGUAGES } from "@/lib/module-flows/seo/brief";
import { compactCount } from "@/lib/module-flows/seo/quick-wins";
import type { SeoState, SeoTarget } from "@/lib/module-flows/seo/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  goToSeoStepAction,
  seoBriefDefaultsAction,
} from "@/server/actions/seo-flow-actions";
import {
  researchRefreshAction,
  seoTargetPagesAction,
  suggestSnippetAction,
} from "@/server/actions/seo-mode-actions";
import type { SeoTargetPage } from "@/server/modules/seo/target";

import { SEO_FLOW_COPY as COPY } from "./copy";
import {
  Field,
  NATIVE_SELECT_CLASS,
  RunNote,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";

// SC-F6: Tazeleme ve başlık düzeltme kiplerinin Brief adımı: hangi sayfa.
// Adres elle yazılır ya da sitenin sayfalarından seçilir; kendi tarayıcımızla
// okunmuş sayfa özeti (varsa) altında görünür. Adres sunucuda doğrulanır ve
// okunur; burası yalnız boş olmasın diye bakar.

const SUBMIT = "submit";
const KEEP = "goto:plan";

// Kişinin yazdığı adresi sunucunun beklediği mutlak http(s) adresine çevirir:
// şemasız "example.com/blog" https alır; yazıdan adres çıkmıyorsa null.
export function pageUrlOf(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(full);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

type PagesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; pages: SeoTargetPage[] }
  | { status: "failed" };

export function TargetPicker({
  projectId,
  commandId,
  state,
  mode,
  running,
  blocked,
  onMoving,
}: {
  projectId?: string;
  commandId?: string;
  state: SeoState;
  mode: "refresh" | "snippet";
  running: boolean;
  blocked: string | null;
  onMoving?: OnMoving;
}) {
  const ids = useId();
  const [url, setUrl] = useState(state.target?.url ?? state.pendingUrl ?? "");
  const [language, setLanguage] = useState(state.brief?.language ?? "");
  const [pages, setPages] = useState<PagesState>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const edited = useRef(false);

  // Dil hiç seçilmemişse markanın dili varsayılan gelir; kişi değiştirdiyse
  // geç gelen varsayılan onu ezmez.
  useEffect(() => {
    if (state.brief || !projectId) return;
    let cancelled = false;
    startTransition(async () => {
      const result = await seoBriefDefaultsAction(projectId);
      if (cancelled || !result.ok || edited.current) return;
      if (result.language) startTransition(() => setLanguage(result.language));
    });
    return () => {
      cancelled = true;
    };
  }, [state.brief, projectId]);

  const togglePages = () => {
    const next = !open;
    setOpen(next);
    if (!next || pages.status !== "idle" || !projectId) return;
    setPages({ status: "loading" });
    startTransition(async () => {
      try {
        const result = await seoTargetPagesAction(projectId);
        startTransition(() =>
          setPages(
            result.ok
              ? { status: "ready", pages: result.pages }
              : { status: "failed" },
          ),
        );
      } catch {
        startTransition(() => setPages({ status: "failed" }));
      }
    });
  };

  const hasResult = mode === "snippet" ? Boolean(state.snippet) : Boolean(state.plan);
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [SUBMIT]: "plan", [KEEP]: "plan" },
    server: (id, card) => {
      if (id === KEEP) {
        return goToSeoStepAction(card.projectId, card.commandId, "plan");
      }
      const input = { url: pageUrlOf(url) ?? url.trim(), language };
      return mode === "snippet"
        ? suggestSnippetAction(card.projectId, card.commandId, input)
        : researchRefreshAction(card.projectId, card.commandId, input);
    },
  });
  const submitting = busyId === SUBMIT;
  const working = running || submitting;
  const ready = pageUrlOf(url) !== null && language !== "";

  const submitLabel =
    mode === "snippet"
      ? submitting
        ? COPY.suggestingTitles
        : COPY.suggestTitles
      : submitting
        ? COPY.planningRefresh
        : COPY.planRefresh;
  const buttons: CardButton[] = [
    serverButton(
      SUBMIT,
      submitLabel,
      "primary",
      blocked ?? (ready ? null : COPY.pageUrl),
    ),
    ...(hasResult && !working
      ? [
          serverButton(
            KEEP,
            mode === "snippet" ? COPY.keepSuggestions : COPY.keepPlan,
            "quiet",
            blocked,
          ),
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      <fieldset disabled={working} className="space-y-3">
        <Field
          label={COPY.pageUrl}
          htmlFor={`${ids}-url`}
          aside={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={open}
              onClick={togglePages}
            >
              {open ? COPY.hidePages : COPY.pickFromPages}
              {open ? (
                <ChevronUp aria-hidden="true" />
              ) : (
                <ChevronDown aria-hidden="true" />
              )}
            </Button>
          }
        >
          <Input
            id={`${ids}-url`}
            value={url}
            inputMode="url"
            autoComplete="url"
            maxLength={2048}
            placeholder={COPY.pageUrlPlaceholder}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>

        {open ? (
          <PageList
            pages={pages}
            onPick={(page) => {
              setUrl(page.url);
              setOpen(false);
            }}
          />
        ) : null}

        <Field label={COPY.language} htmlFor={`${ids}-language`}>
          <select
            id={`${ids}-language`}
            value={language}
            className={NATIVE_SELECT_CLASS}
            style={{ color: "var(--ws-text)" }}
            onChange={(event) => {
              edited.current = true;
              setLanguage(event.target.value);
            }}
          >
            <option value="" disabled>
              {COPY.languagePlaceholder}
            </option>
            {SEO_LANGUAGES.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        {state.target ? <TargetSnapshot target={state.target} /> : null}
      </fieldset>

      {working ? (
        <RunNote text={mode === "snippet" ? COPY.snippetNote : COPY.refreshNote} />
      ) : null}
      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}

function PageList({
  pages,
  onPick,
}: {
  pages: PagesState;
  onPick: (page: SeoTargetPage) => void;
}) {
  if (pages.status === "loading" || pages.status === "idle") {
    return (
      <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
        {COPY.pagesLoading}
      </p>
    );
  }
  if (pages.status === "failed") {
    return (
      <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
        {COPY.pagesFailed}
      </p>
    );
  }
  if (pages.pages.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
        {COPY.pagesNone}
      </p>
    );
  }
  return (
    <ul
      className="max-h-56 divide-y overflow-y-auto rounded-xl border"
      style={{ borderColor: "var(--ws-border)" }}
    >
      {pages.pages.map((page) => (
        <li key={page.url}>
          <button
            type="button"
            onClick={() => onPick(page)}
            className="flex min-h-10 w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span
              className="min-w-0 truncate text-sm"
              style={{ color: "var(--ws-text)" }}
            >
              {page.path}
            </span>
            <span
              className="shrink-0 text-[11px] tabular-nums"
              style={{ color: "var(--ws-text-3)" }}
            >
              {page.source === "SEARCH" && page.clicks !== null
                ? COPY.pageClicks(compactCount(page.clicks))
                : COPY.pageOnSite}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Sayfanın bugünkü hali: kendi tarayıcımızla okunmuş, sitenin kendi verisi.
// "Ranks for N searches" Google kaynaklıdır ve yalnız sayı olarak gösterilir.
function TargetSnapshot({ target }: { target: SeoTarget }) {
  return (
    <div
      className="space-y-1 rounded-xl border px-3 py-2.5"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <p className="text-[11px] font-medium" style={{ color: "var(--ws-text-2)" }}>
        {COPY.pageSnapshot}
      </p>
      <p
        className="text-sm leading-5 font-medium break-words"
        style={{ color: "var(--ws-text)" }}
      >
        {target.title ?? COPY.pageNoTitle}
      </p>
      {target.metaDescription ? (
        <p
          className="line-clamp-2 text-xs leading-5"
          style={{ color: "var(--ws-text-2)" }}
        >
          {target.metaDescription}
        </p>
      ) : null}
      <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
        {[
          target.path,
          target.wordCount !== null ? COPY.pageWords(target.wordCount) : null,
          target.queryCount > 0 ? COPY.ranksFor(target.queryCount) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}
