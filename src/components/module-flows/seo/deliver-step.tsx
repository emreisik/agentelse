"use client";

import { CalendarCheck, Check, Code2, FileText } from "lucide-react";
import { useState } from "react";

import { CopyButton } from "@/components/calendar/copy-button";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { CardActions } from "@/components/works/card-actions";
import { todayKeyIn } from "@/lib/date-picker";
import {
  defaultPublishAt,
  formatDay,
  formatWhen,
  isWallClock,
} from "@/lib/module-flows/seo/deliver";
import { markdownToHtml } from "@/lib/module-flows/seo/markdown";
import type { SeoArticle, SeoState } from "@/lib/module-flows/seo/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  goToSeoStepAction,
  markSeoPublishedAction,
  scheduleSeoArticleAction,
} from "@/server/actions/seo-flow-actions";

import { SEO_FLOW_COPY as COPY } from "./copy";
import {
  Field,
  copyToClipboard,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";

// Step 5, Publish: there is no CMS connection, so the person posts the article
// on their site. The card hands it over (title, meta description, Markdown or
// HTML), puts it on the Content Calendar for the day it goes live, and records
// when it is out ("Mark as published", the calendar's own manual path).

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
  onMoving?: OnMoving;
};

export function DeliverStep(props: Props) {
  const { article } = props.state;
  if (!article) return null;
  return <DeliverBody {...props} article={article} />;
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
  onMoving,
  article,
}: Props & { article: SeoArticle }) {
  const { delivery } = state;
  const [when, setWhen] = useState(() =>
    defaultPublishAt(todayKeyIn(timezone)),
  );
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [BACK]: "review" },
    server: (id, card) =>
      id === SCHEDULE
        ? scheduleSeoArticleAction(card.projectId, card.commandId, when)
        : id === PUBLISHED
          ? markSeoPublishedAction(card.projectId, card.commandId)
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

      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}
