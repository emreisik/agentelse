"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CardActions } from "@/components/works/card-actions";
import { useWorkCardHost } from "@/components/works/work-card-host";
import { ON_PAGE_RULES } from "@/lib/module-flows/seo/on-page";
import {
  applyPlanEdits,
  sameKeyword,
  withKeyword,
} from "@/lib/module-flows/seo/plan";
import { compactCount } from "@/lib/module-flows/seo/quick-wins";
import {
  SEO_LIMITS,
  type SeoPlan,
  type SeoQuickWins,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  goToSeoStepAction,
  researchSeoAction,
  writeSeoArticleAction,
} from "@/server/actions/seo-flow-actions";

import { INTENT_LABEL, SEO_FLOW_COPY as COPY } from "./copy";
import {
  Field,
  WorkingNote,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";

// Step 2, Plan: the researched keyword, intent, titles, meta description and
// outline, all editable on the card (pick a title, reshape the sections, add a
// Search Console quick win as a keyword). "Write article" sends the plan as
// the person left it. While the research runs (or after it stopped) the step
// says so instead.

const WRITE = "write";
const RETRY = "retry";
const BACK = "goto:brief";
const TO_ARTICLE = "goto:review";

// The Search Console integration (server/integrations/google-client.ts
// GOOGLE_PROVIDER.search_console), opened on the integrations page.
const SEARCH_CONSOLE_INTEGRATION = "google_search_console";

type Props = {
  projectId?: string;
  commandId?: string;
  state: SeoState;
  // A model call holds the card (this or another tab).
  running: boolean;
  blocked: string | null;
  onMoving?: OnMoving;
};

export function PlanStep(props: Props) {
  const { plan } = props.state;
  if (props.running || !plan) return <PlanWaiting {...props} />;
  return <PlanEditor {...props} plan={plan} key={plan.researchedAt} />;
}

// Researching, or the research stopped before it answered.
function PlanWaiting({
  projectId,
  commandId,
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
        : researchSeoAction(card.projectId, card.commandId),
  });
  if (running || busyId === RETRY) {
    return <WorkingNote>{COPY.researchNote}</WorkingNote>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        {COPY.researchStopped}
      </p>
      <CardActions
        buttons={[
          serverButton(RETRY, COPY.tryAgain, "primary", blocked),
          serverButton(BACK, COPY.back, "quiet", blocked),
        ]}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}

type SectionRow = { key: string; h2: string; points: string[] };

function charsOf(text: string): number {
  return Array.from(text.trim()).length;
}

function PlanEditor({
  projectId,
  commandId,
  state,
  blocked,
  onMoving,
  plan,
}: Props & { plan: SeoPlan }) {
  const host = useWorkCardHost();
  const ids = useId();
  const nextKey = useRef(plan.outline.length);
  const [titleIndex, setTitleIndex] = useState(plan.titleIndex);
  const [meta, setMeta] = useState(plan.metaDescription);
  const [keywords, setKeywords] = useState<string[]>(plan.secondaryKeywords);
  const [sections, setSections] = useState<SectionRow[]>(() =>
    plan.outline.map((section, index) => ({ key: `s${index}`, ...section })),
  );

  const edits = {
    titleIndex,
    metaDescription: meta,
    secondaryKeywords: keywords,
    outline: sections.map(({ h2, points }) => ({ h2, points })),
  };
  const check = applyPlanEdits(plan, edits);

  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [WRITE]: "create", [BACK]: "brief", [TO_ARTICLE]: "review" },
    server: (id, card) =>
      id === WRITE
        ? writeSeoArticleAction(card.projectId, card.commandId, edits)
        : goToSeoStepAction(
            card.projectId,
            card.commandId,
            id === BACK ? "brief" : "review",
          ),
  });
  const writing = busyId === WRITE;

  const move = (index: number, by: -1 | 1) =>
    setSections((rows) => {
      const target = index + by;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });
  const metaChars = charsOf(meta);
  const metaInRange =
    metaChars >= ON_PAGE_RULES.meta.min && metaChars <= ON_PAGE_RULES.meta.max;

  const buttons: CardButton[] = [
    serverButton(
      WRITE,
      writing ? COPY.writing : COPY.write,
      "primary",
      blocked ?? (check.ok ? null : check.message),
    ),
    serverButton(BACK, COPY.back, "quiet", blocked),
    ...(state.article
      ? [serverButton(TO_ARTICLE, COPY.backToArticle, "quiet", blocked)]
      : []),
  ];

  return (
    <div className="space-y-4">
      <fieldset disabled={writing} className="space-y-4">
        <Field label={COPY.primaryKeyword}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p
              className="text-sm font-semibold break-words"
              style={{ color: "var(--ws-text)" }}
            >
              {plan.primaryKeyword}
            </p>
            <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {INTENT_LABEL[plan.searchIntent]}
            </span>
          </div>
          {plan.intentNote ? (
            <p
              className="text-xs leading-5"
              style={{ color: "var(--ws-text-2)" }}
            >
              {plan.intentNote}
            </p>
          ) : null}
        </Field>

        <Field label={COPY.secondaryKeywords}>
          {keywords.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {keywords.map((keyword) => (
                <li key={keyword}>
                  <span
                    className="inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
                    style={{
                      borderColor: "var(--ws-border)",
                      color: "var(--ws-text)",
                    }}
                  >
                    <span className="truncate">{keyword}</span>
                    <button
                      type="button"
                      aria-label={COPY.removeKeyword(keyword)}
                      onClick={() =>
                        setKeywords((list) =>
                          list.filter((item) => item !== keyword),
                        )
                      }
                      className="grid size-6 shrink-0 place-items-center rounded-full outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <X aria-hidden="true" className="size-3" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
              {COPY.noSecondary}
            </p>
          )}
        </Field>

        <QuickWins
          quickWins={plan.quickWins}
          keywords={keywords}
          primary={plan.primaryKeyword}
          connectHref={
            projectId
              ? `/projects/${projectId}/integrations?integration=${SEARCH_CONSOLE_INTEGRATION}${
                  host?.workId ? `&from=${encodeURIComponent(host.workId)}` : ""
                }`
              : null
          }
          onAdd={(query) =>
            setKeywords((list) => withKeyword(list, query, plan.primaryKeyword))
          }
        />

        <fieldset className="space-y-1.5">
          <legend
            className="mb-1.5 text-xs font-medium"
            style={{ color: "var(--ws-text-2)" }}
          >
            {COPY.title}
          </legend>
          {plan.titleOptions.map((title, index) => {
            const chars = charsOf(title);
            const inRange =
              chars >= ON_PAGE_RULES.title.min &&
              chars <= ON_PAGE_RULES.title.max;
            return (
              <label
                key={title}
                className="flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 transition-colors hover:bg-[var(--ws-hover)]"
                style={{
                  borderColor:
                    titleIndex === index
                      ? "var(--ws-accent)"
                      : "var(--ws-border)",
                }}
              >
                <input
                  type="radio"
                  name={`${ids}-title`}
                  checked={titleIndex === index}
                  onChange={() => setTitleIndex(index)}
                  className="mt-1 size-3.5 shrink-0"
                  style={{ accentColor: "var(--ws-accent)" }}
                />
                <span
                  className="min-w-0 flex-1 text-sm break-words"
                  style={{ color: "var(--ws-text)" }}
                >
                  {title}
                </span>
                <span
                  className="shrink-0 pt-0.5 text-[11px] tabular-nums"
                  style={{
                    color: inRange ? "var(--ws-text-3)" : "var(--ws-pending)",
                  }}
                >
                  {chars}
                </span>
              </label>
            );
          })}
        </fieldset>

        <Field
          label={COPY.meta}
          htmlFor={`${ids}-meta`}
          aside={
            <span
              className="text-[11px] tabular-nums"
              style={{
                color: metaInRange ? "var(--ws-text-3)" : "var(--ws-pending)",
              }}
            >
              {metaChars} / {ON_PAGE_RULES.meta.min}–{ON_PAGE_RULES.meta.max}
            </span>
          }
        >
          <Textarea
            id={`${ids}-meta`}
            value={meta}
            rows={3}
            maxLength={SEO_LIMITS.meta}
            onChange={(event) => setMeta(event.target.value)}
          />
        </Field>

        <Field label={COPY.outline}>
          <ol className="space-y-2">
            {sections.map((section, index) => (
              <li key={section.key} className="flex items-start gap-1.5">
                <span
                  className="w-5 shrink-0 pt-1.5 text-right text-xs tabular-nums"
                  style={{ color: "var(--ws-text-3)" }}
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <Input
                    value={section.h2}
                    maxLength={SEO_LIMITS.h2}
                    aria-label={COPY.sectionHeading(index + 1)}
                    onChange={(event) => {
                      const h2 = event.target.value;
                      setSections((rows) =>
                        rows.map((row) =>
                          row.key === section.key ? { ...row, h2 } : row,
                        ),
                      );
                    }}
                  />
                  {section.points.length > 0 ? (
                    <p
                      className="text-[11px] leading-4"
                      style={{ color: "var(--ws-text-3)" }}
                    >
                      {section.points.join(" · ")}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={COPY.moveUp(index + 1)}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={COPY.moveDown(index + 1)}
                    disabled={index === sections.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={COPY.removeSection(index + 1)}
                    disabled={sections.length <= 1}
                    onClick={() =>
                      setSections((rows) =>
                        rows.filter((row) => row.key !== section.key),
                      )
                    }
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={sections.length >= SEO_LIMITS.sectionsMax}
            onClick={() => {
              const key = `s${nextKey.current++}`;
              setSections((rows) => [...rows, { key, h2: "", points: [] }]);
            }}
          >
            <Plus aria-hidden="true" />
            {COPY.addSection}
          </Button>
        </Field>
      </fieldset>

      {writing ? <WorkingNote>{COPY.writeNote}</WorkingNote> : null}
      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}

function QuickWins({
  quickWins,
  keywords,
  primary,
  connectHref,
  onAdd,
}: {
  quickWins: SeoQuickWins;
  keywords: readonly string[];
  primary: string;
  connectHref: string | null;
  onAdd: (query: string) => void;
}) {
  const note = (text: string, link?: { href: string; label: string }) => (
    <p className="text-xs leading-5" style={{ color: "var(--ws-text-3)" }}>
      {text}
      {link ? (
        <>
          {" "}
          <Link
            href={link.href}
            className="font-medium underline underline-offset-2"
          >
            {link.label}
          </Link>
        </>
      ) : null}
    </p>
  );

  if (quickWins.state === "not-connected") {
    return (
      <Field label={COPY.quickWins}>
        {note(
          COPY.quickWinsMissing,
          connectHref
            ? { href: connectHref, label: COPY.quickWinsConnect }
            : undefined,
        )}
      </Field>
    );
  }
  if (quickWins.state === "failed") {
    return <Field label={COPY.quickWins}>{note(COPY.quickWinsFailed)}</Field>;
  }
  const open = quickWins.items.filter(
    (win) =>
      !sameKeyword(win.query, primary) &&
      !keywords.some((keyword) => sameKeyword(keyword, win.query)),
  );
  if (quickWins.items.length === 0) {
    return <Field label={COPY.quickWins}>{note(COPY.quickWinsNone)}</Field>;
  }
  if (open.length === 0) return null;
  return (
    <Field label={COPY.quickWins}>
      <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
        {COPY.quickWinsHint}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {open.map((win) => (
          <li key={win.query}>
            <button
              type="button"
              aria-label={COPY.quickWinAria(
                win.query,
                win.impressions,
                win.position,
              )}
              disabled={keywords.length >= SEO_LIMITS.secondaryMax}
              onClick={() => onAdd(win.query)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text)",
              }}
            >
              <Plus aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">{win.query}</span>
              <span
                aria-hidden="true"
                className="shrink-0 tabular-nums"
                style={{ color: "var(--ws-text-3)" }}
              >
                {compactCount(win.impressions)} · #{Math.round(win.position)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Field>
  );
}
