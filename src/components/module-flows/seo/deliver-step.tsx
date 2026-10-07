"use client";

import { CalendarCheck, Check, Code2, FileText } from "lucide-react";
import { useId, useState } from "react";

import { CopyButton } from "@/components/calendar/copy-button";
import { SnippetApplyPanel } from "@/components/seo-apply/apply-with-approval-button";
import { PublishToWordPress } from "@/components/seo-apply/publish-to-wordpress";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Input } from "@/components/ui/input";
import { CardActions } from "@/components/works/card-actions";
import { useWorkCardHost } from "@/components/works/work-card-host";
import { todayKeyIn } from "@/lib/date-picker";
import {
  defaultPublishAt,
  plannedPublishAt,
  formatDay,
  formatWhen,
  isWallClock,
} from "@/lib/module-flows/seo/deliver";
import { markdownToHtml } from "@/lib/module-flows/seo/markdown";
import {
  seoModeOf,
  type SeoArticle,
  type SeoMode,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  goToSeoStepAction,
  markSeoPublishedAction,
  scheduleSeoArticleAction,
} from "@/server/actions/seo-flow-actions";
import {
  markSeoAppliedAction,
  startSeoCardAction,
} from "@/server/actions/seo-mode-actions";

import { CardStatus } from "./card-status";
import { SEO_FLOW_COPY as COPY } from "./copy";
import {
  Field,
  copyToClipboard,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";
import { useCardStatus } from "./use-card-status";

// Step 5, Publish: there is no CMS connection, so the person posts the article
// on their site. The card hands it over (title, meta description, Markdown or
// HTML), puts it on the Content Calendar for the day it goes live, and records
// when it is out ("Mark as published", the calendar's own manual path).
// SC-F6: with state.features.modes a live page address can be added; "Refresh a
// page" and "Fix a snippet" hand over the copy and ask "I've updated my site";
// with state.features.live the card then shows what happened (CardStatus) and
// offers the next card in the same Work.

const SCHEDULE = "schedule";
const PUBLISHED = "published";
const BACK = "goto:review";
const CALENDAR = "calendar";

type Props = {
  projectId?: string;
  commandId?: string;
  state: SeoState;
  blocked: string | null;
  timezone?: string;
  // SC-F7: aylık plan slotunun tarihi (kart ipucu); varsa seçicinin ilk değeri.
  plannedAt?: string;
  onMoving?: OnMoving;
};

export function DeliverStep(props: Props) {
  const { state } = props;
  if (seoModeOf(state) !== "article") return <AppliedDeliver {...props} />;
  const { article } = state;
  if (!article) return null;
  return <DeliverBody {...props} article={article} />;
}

// Kartın "ne oldu" bölümü ve sıradaki kart; yalnız canlı özellik açıkken.
function Results({
  projectId,
  commandId,
  state,
  blocked,
  timezone,
  onMoving,
}: Props) {
  const modes = state.features?.modes === true;
  const { status, reload } = useCardStatus({
    projectId,
    commandId,
    enabled: true,
    version: JSON.stringify([
      state.actionId ?? null,
      state.delivery?.scheduledFor ?? null,
      state.delivery?.publishedAt ?? null,
      state.applied?.at ?? null,
    ]),
  });
  const done = Boolean(state.delivery || state.applied);
  return (
    <>
      <CardStatus
        projectId={projectId}
        commandId={commandId}
        status={status}
        blocked={blocked}
        timezone={timezone}
        modes={modes}
        onChanged={reload}
      />
      {done ? (
        <NextRow
          projectId={projectId}
          commandId={commandId}
          modes={modes}
          blocked={blocked}
          onMoving={onMoving}
        />
      ) : null}
    </>
  );
}

const NEXT_PREFIX = "next:";

// Aynı Work'te yeni bir SEO kartı: başka makale, sayfa tazeleme ya da başlık
// düzeltme. Her biri yeni kart açar; bu kart olduğu gibi kalır.
function NextRow({
  projectId,
  commandId,
  modes,
  blocked,
  onMoving,
}: {
  projectId?: string;
  commandId?: string;
  modes: boolean;
  blocked: string | null;
  onMoving?: OnMoving;
}) {
  const host = useWorkCardHost();
  const workId = host?.workId;
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    server: (id, card) => {
      const mode = id.slice(NEXT_PREFIX.length) as SeoMode;
      return workId
        ? startSeoCardAction(card.projectId, workId, mode)
        : Promise.resolve({ ok: false as const, message: COPY.anotherFailed });
    },
  });
  const reason = blocked ?? (workId ? null : COPY.unavailable);
  const buttons: CardButton[] = [
    serverButton(
      `${NEXT_PREFIX}article`,
      COPY.writeAnother,
      "secondary",
      reason,
    ),
    ...(modes
      ? [
          serverButton(
            `${NEXT_PREFIX}refresh`,
            COPY.refreshPage,
            "quiet",
            reason,
          ),
          serverButton(
            `${NEXT_PREFIX}snippet`,
            COPY.fixSnippet,
            "quiet",
            reason,
          ),
        ]
      : []),
  ];
  return (
    <Field label={COPY.next}>
      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </Field>
  );
}

// "Refresh a page" and "Fix a snippet": the copy to paste into the existing
// page and "I've updated my site". Once applied, the card says so and shows
// what Agentelse found out (CardStatus).
const APPLIED = "applied";
const BACK_TO = "goto:back";

function AppliedDeliver({
  projectId,
  commandId,
  state,
  blocked,
  timezone,
  onMoving,
}: Props) {
  const mode = seoModeOf(state);
  const { article, snippet, applied } = state;
  const text =
    mode === "snippet"
      ? snippet && snippet.chosen !== null
        ? (snippet.edited ?? snippet.variants[snippet.chosen] ?? null)
        : null
      : article
        ? { title: article.title, metaDescription: article.metaDescription }
        : null;
  const backTo = mode === "snippet" ? "plan" : "review";
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [BACK_TO]: backTo },
    server: (id, card) =>
      id === APPLIED
        ? markSeoAppliedAction(card.projectId, card.commandId)
        : goToSeoStepAction(card.projectId, card.commandId, backTo),
  });
  if (!text) return null;

  const buttons: CardButton[] = applied
    ? []
    : [
        serverButton(APPLIED, COPY.markApplied, "primary", blocked),
        serverButton(
          BACK_TO,
          mode === "snippet" ? COPY.back : COPY.backToReview,
          "quiet",
          blocked,
        ),
      ];

  return (
    <div className="space-y-4">
      {applied ? null : (
        <p className="text-sm leading-5" style={{ color: "var(--ws-text-2)" }}>
          {mode === "snippet" ? COPY.snippetIntro : COPY.updatedIntro}
        </p>
      )}

      <CopyField label={COPY.title} text={text.title} />
      {text.metaDescription ? (
        <CopyField label={COPY.meta} text={text.metaDescription} />
      ) : null}

      {mode === "refresh" && article ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copyToClipboard(article.markdown, "Markdown")}
          >
            <FileText aria-hidden="true" />
            {COPY.copyMarkdown}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              copyToClipboard(markdownToHtml(article.markdown), "HTML")
            }
          >
            <Code2 aria-hidden="true" />
            {COPY.copyHtml}
          </Button>
        </div>
      ) : null}

      {applied ? (
        <p
          className="flex items-center gap-1.5 text-sm font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          <Check
            aria-hidden="true"
            className="size-4 shrink-0"
            style={{ color: "var(--ws-approved)" }}
          />
          {COPY.updatedOn(formatDay(applied.at, timezone))}
        </p>
      ) : null}

      {buttons.length > 0 ? (
        <CardActions
          buttons={buttons}
          onAct={onAct}
          busyId={busyId}
          error={error}
        />
      ) : null}

      {/* SC-F8: yalnız features.apply ile (sunucu damgası); features.live'a bağlı değildir. */}
      {mode === "snippet" &&
      !applied &&
      projectId &&
      state.actionId &&
      state.features?.apply === true ? (
        <SnippetApplyPanel
          projectId={projectId}
          actionId={state.actionId}
          title={text.title}
          metaDescription={text.metaDescription}
          applyReady
        />
      ) : null}

      {state.features?.live ? (
        <Results
          projectId={projectId}
          commandId={commandId}
          state={state}
          blocked={blocked}
          timezone={timezone}
          onMoving={onMoving}
        />
      ) : null}
    </div>
  );
}

function CopyField({ label, text }: { label: string; text: string }) {
  return (
    <Field label={label} aside={<CopyButton text={text} label={label} />}>
      <p
        className="text-sm leading-5 break-words"
        style={{ color: "var(--ws-text)" }}
      >
        {text}
      </p>
    </Field>
  );
}

function DeliverBody({
  projectId,
  commandId,
  state,
  blocked,
  timezone,
  plannedAt,
  onMoving,
  article,
}: Props & { article: SeoArticle }) {
  const { delivery } = state;
  const [when, setWhen] = useState(
    () =>
      plannedPublishAt(plannedAt, timezone, new Date()) ??
      defaultPublishAt(todayKeyIn(timezone)),
  );
  const modes = state.features?.modes === true;
  const ids = useId();
  const [liveUrl, setLiveUrl] = useState("");
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [BACK]: "review" },
    server: (id, card) =>
      id === SCHEDULE
        ? scheduleSeoArticleAction(card.projectId, card.commandId, when)
        : id === PUBLISHED
          ? modes && liveUrl.trim()
            ? markSeoPublishedAction(
                card.projectId,
                card.commandId,
                liveUrl.trim(),
              )
            : markSeoPublishedAction(card.projectId, card.commandId)
          : goToSeoStepAction(card.projectId, card.commandId, "review"),
  });

  const openCalendar: CardButton = {
    id: CALENDAR,
    label: COPY.openCalendar,
    emphasis: delivery?.publishedAt ? "secondary" : "quiet",
    action: { kind: "tab", tab: "calendar" },
  };

  const buttons: CardButton[] = delivery?.publishedAt
    ? [openCalendar]
    : delivery
      ? [
          serverButton(PUBLISHED, COPY.markPublished, "primary", blocked),
          openCalendar,
        ]
      : [
          serverButton(
            SCHEDULE,
            COPY.addToCalendar,
            "primary",
            blocked ?? (isWallClock(when) ? null : COPY.pickWhen),
          ),
          serverButton(PUBLISHED, COPY.markPublished, "secondary", blocked),
          serverButton(BACK, COPY.backToReview, "quiet", blocked),
        ];

  const deliveryTimezone = delivery?.timezone ?? timezone;

  return (
    <div className="space-y-4">
      {delivery?.publishedAt ? null : (
        <p className="text-sm leading-5" style={{ color: "var(--ws-text-2)" }}>
          {COPY.deliverIntro}
        </p>
      )}

      <CopyField label={COPY.title} text={article.title} />
      {article.metaDescription ? (
        <CopyField label={COPY.meta} text={article.metaDescription} />
      ) : null}

      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copyToClipboard(article.markdown, "Markdown")}
          >
            <FileText aria-hidden="true" />
            {COPY.copyMarkdown}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              copyToClipboard(markdownToHtml(article.markdown), "HTML")
            }
          >
            <Code2 aria-hidden="true" />
            {COPY.copyHtml}
          </Button>
        </div>
        <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
          {COPY.pasteHint}
        </p>
      </div>

      <div
        className="border-t pt-3"
        style={{ borderColor: "var(--ws-border)" }}
      >
        {delivery?.publishedAt ? (
          <p
            className="flex items-center gap-1.5 text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            <Check
              aria-hidden="true"
              className="size-4 shrink-0"
              style={{ color: "var(--ws-approved)" }}
            />
            {COPY.publishedOn(
              formatDay(delivery.publishedAt, deliveryTimezone),
            )}
          </p>
        ) : delivery ? (
          <p
            className="flex items-center gap-1.5 text-sm"
            style={{ color: "var(--ws-text)" }}
          >
            <CalendarCheck
              aria-hidden="true"
              className="size-4 shrink-0"
              style={{ color: "var(--ws-text-2)" }}
            />
            {COPY.onCalendar(
              formatWhen(delivery.scheduledFor, deliveryTimezone),
            )}
          </p>
        ) : (
          <Field label={COPY.when}>
            <DateTimePicker
              value={when}
              onChange={setWhen}
              timezone={timezone}
              disablePast
              aria-label={COPY.when}
              disabled={busyId !== null}
            />
          </Field>
        )}
      </div>

      {modes && !delivery?.publishedAt ? (
        <Field label={COPY.liveUrl} htmlFor={`${ids}-live`}>
          <Input
            id={`${ids}-live`}
            value={liveUrl}
            inputMode="url"
            autoComplete="url"
            maxLength={2048}
            placeholder={COPY.liveUrlPlaceholder}
            disabled={busyId !== null}
            onChange={(event) => setLiveUrl(event.target.value)}
          />
          <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
            {COPY.liveUrlHint}
          </p>
        </Field>
      ) : null}

      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />

      {/* SC-F8: WordPress'e taslak gönderme; yalnız features.apply ile (sunucu damgası). */}
      {state.features?.apply === true ? (
        projectId && delivery?.creativeId ? (
          <PublishToWordPress
            projectId={projectId}
            creativeId={delivery.creativeId}
            isManager={false}
          />
        ) : (
          <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
            {COPY.scheduleFirstForWordPress}
          </p>
        )
      ) : null}

      {state.features?.live ? (
        <Results
          projectId={projectId}
          commandId={commandId}
          state={state}
          blocked={blocked}
          timezone={timezone}
          onMoving={onMoving}
        />
      ) : null}
    </div>
  );
}
