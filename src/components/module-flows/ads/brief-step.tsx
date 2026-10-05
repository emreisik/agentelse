"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { Check } from "lucide-react";

import { GenderToggle } from "@/components/ads/gender-toggle";
import { GeoTargetSelect } from "@/components/ads/geo-target-select";
import { ChannelMark } from "@/components/commands/channel-badge";
import { BrandTile } from "@/components/integrations/brand-icons";
import { CardActions } from "@/components/works/card-actions";
import { assetUrl } from "@/lib/asset-url";
import {
  ADS_ACCOUNT_COPY,
  ADS_FLOW_COPY,
  metaAdsSettingsHref,
} from "@/lib/module-flows/ads/copy";
import {
  ADS_CTAS,
  ADS_CTA_LABEL,
  ADS_DURATIONS,
  ADS_LIMITS,
  ADS_OBJECTIVES,
  ADS_OBJECTIVE_META,
  DEFAULT_ADS_DURATION,
  DEFAULT_AGE_MAX,
  DEFAULT_AGE_MIN,
  briefIssue,
  formatBudget,
  genderFromToggle,
  genderToggleValue,
  normalizeBudget,
  withScheme,
  type AdsBrief,
  type AdsBriefInput,
  type AdsBriefOptions,
  type AdsCallToAction,
  type AdsDuration,
  type AdsFlowState,
  type AdsGender,
  type AdsObjective,
  type AdsSourcePost,
} from "@/lib/module-flows/ads/state";
import type { CardButton } from "@/lib/works/card-action";
import { loadAdsBriefOptionsAction } from "@/server/actions/ads-flow-actions";

import {
  Chip,
  FIELD_CLASS,
  FIELD_STYLE,
  LoadingLine,
  Section,
  type StepActions,
} from "./parts";

// Step 1, Brief: Meta (Google Ads later), the post the ad is made from, the
// goal, the budget and how long, who sees it, and where it leads. Blocked with
// one clear way forward when Meta Ads is not set up or there is no post yet.

const COPY = ADS_FLOW_COPY;

// "12,5" is 12.5 too; an empty field is no number.
function numberOf(text: string): number {
  const clean = text.trim().replace(",", ".");
  return clean ? Number(clean) : Number.NaN;
}

export function AdsBriefStep({
  projectId,
  commandId,
  state,
  gate,
  actions,
  onNext,
  initialOptions,
}: {
  projectId: string;
  commandId: string;
  state: AdsFlowState;
  gate: string | null;
  actions: StepActions;
  // Saves the brief (the card's own write, then the AI writes the ad).
  onNext: (input: unknown) => void;
  // Already read (tests); otherwise read when the step shows.
  initialOptions?: AdsBriefOptions;
}) {
  const [loaded, setLoaded] = useState<AdsBriefOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [, startLoading] = useTransition();
  const options = initialOptions ?? loaded;

  useEffect(() => {
    if (initialOptions) return;
    let alive = true;
    startLoading(async () => {
      const result = await loadAdsBriefOptionsAction(
        projectId,
        commandId,
      ).catch(() => null);
      if (!alive) return;
      if (result?.ok) {
        setLoaded(result.options);
        setLoadError(null);
      } else {
        setLoadError(result?.message || COPY.optionsFailed);
      }
    });
    return () => {
      alive = false;
    };
  }, [projectId, commandId, attempt, initialOptions]);

  return (
    <div className="space-y-4">
      <PlatformChoice />
      {options ? (
        <BriefBody
          projectId={projectId}
          state={state}
          options={options}
          gate={gate}
          actions={actions}
          onNext={onNext}
        />
      ) : loadError ? (
        <div className="space-y-2">
          <p
            role="alert"
            className="text-sm"
            style={{ color: "var(--ws-text)" }}
          >
            {loadError}
          </p>
          <CardActions
            buttons={[
              {
                id: "brief:retry",
                label: COPY.retry,
                emphasis: "secondary",
                action: { kind: "server", id: "brief:retry" },
              },
            ]}
            onAct={() => {
              setLoadError(null);
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      ) : (
        <LoadingLine>{COPY.optionsLoading}</LoadingLine>
      )}
    </div>
  );
}

// Meta now; Google Ads is shown, not offered.
function PlatformChoice() {
  return (
    <Section label={COPY.platform}>
      <div
        role="radiogroup"
        aria-label={COPY.platform}
        className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2"
      >
        <div
          role="radio"
          aria-checked="true"
          tabIndex={0}
          className="flex min-h-12 items-center gap-2.5 rounded-xl border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ borderColor: "var(--ws-accent)" }}
        >
          <BrandTile
            brand="meta-ads"
            className="size-8"
            iconClassName="size-4"
          />
          <span className="min-w-0 flex-1">
            <span
              className="block text-sm font-medium"
              style={{ color: "var(--ws-text)" }}
            >
              {COPY.meta}
            </span>
            <span
              className="block truncate text-[11px]"
              style={{ color: "var(--ws-text-2)" }}
            >
              {COPY.metaSub}
            </span>
          </span>
          <Check
            aria-hidden="true"
            className="size-4 shrink-0"
            style={{ color: "var(--ws-text)" }}
          />
        </div>
        <div
          role="radio"
          aria-checked="false"
          aria-disabled="true"
          className="flex min-h-12 items-center gap-2.5 rounded-xl border border-dashed px-3 py-2"
          style={{ borderColor: "var(--ws-border)" }}
        >
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-xs font-semibold"
            style={{ background: "var(--ws-hover)", color: "var(--ws-text-3)" }}
          >
            G
          </span>
          <span className="min-w-0 flex-1">
            <span
              className="block text-sm font-medium"
              style={{ color: "var(--ws-text-2)" }}
            >
              {COPY.google}
            </span>
            <span
              className="block text-[11px]"
              style={{ color: "var(--ws-text-3)" }}
            >
              {COPY.soon}
            </span>
          </span>
        </div>
      </div>
    </Section>
  );
}

function BriefBody({
  projectId,
  state,
  options,
  gate,
  actions,
  onNext,
}: {
  projectId: string;
  state: AdsFlowState;
  options: AdsBriefOptions;
  gate: string | null;
  actions: StepActions;
  // Saves the brief (the card's own write, then the AI writes the ad).
  onNext: (input: unknown) => void;
}) {
  const { account, posts } = options;
  if (account.status !== "ready") {
    const href = metaAdsSettingsHref(projectId);
    return (
      <div className="space-y-3">
        <p
          className="rounded-xl border p-3 text-sm"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
        >
          {ADS_ACCOUNT_COPY[account.status].text}
        </p>
        <CardActions
          buttons={[
            {
              id: "brief:connect",
              label:
                account.status === "needs-connect"
                  ? COPY.connect
                  : COPY.finishSetup,
              emphasis: "primary",
              action: { kind: "link", href },
            },
          ]}
          onAct={() => undefined}
        />
      </div>
    );
  }
  if (posts.length === 0) {
    return (
      <div className="space-y-3">
        <Section label={COPY.post}>
          <p
            className="rounded-xl border p-3 text-sm"
            style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
          >
            {COPY.noPosts}
          </p>
        </Section>
        <CardActions
          buttons={[
            {
              id: "brief:social",
              label: COPY.openSocial,
              emphasis: "primary",
              action: {
                kind: "link",
                href: `/projects/${encodeURIComponent(projectId)}?module=social`,
              },
            },
          ]}
          onAct={() => undefined}
        />
      </div>
    );
  }
  return (
    <BriefForm
      brief={state.brief}
      hintId={state.hint?.sourceCreativeId}
      options={options}
      gate={gate}
      actions={actions}
      onNext={onNext}
    />
  );
}

function BriefForm({
  brief,
  hintId,
  options,
  gate,
  actions,
  onNext,
}: {
  brief?: AdsBrief;
  hintId?: string;
  options: AdsBriefOptions;
  gate: string | null;
  actions: StepActions;
  // Saves the brief (the card's own write, then the AI writes the ad).
  onNext: (input: unknown) => void;
}) {
  const baseId = useId();
  const currency = options.account.currency;
  const offered = (id?: string) =>
    id && options.posts.some((post) => post.creativeId === id) ? id : null;
  const [creativeId, setCreativeId] = useState<string | null>(
    () => offered(brief?.source.creativeId) ?? offered(hintId),
  );
  const [objective, setObjective] = useState<AdsObjective>(
    brief?.objective ?? "OUTCOME_TRAFFIC",
  );
  const [budget, setBudget] = useState(brief ? String(brief.dailyBudget) : "");
  const [days, setDays] = useState<AdsDuration>(
    brief?.days ?? DEFAULT_ADS_DURATION,
  );
  const [countries, setCountries] = useState<string[]>(
    brief?.countries ?? options.defaults.countries,
  );
  const [ageMin, setAgeMin] = useState(
    String(brief?.ageMin ?? DEFAULT_AGE_MIN),
  );
  const [ageMax, setAgeMax] = useState(
    String(brief?.ageMax ?? DEFAULT_AGE_MAX),
  );
  const [gender, setGender] = useState<AdsGender>(brief?.gender ?? "all");
  const [link, setLink] = useState(brief?.link ?? options.defaults.link ?? "");
  const [cta, setCta] = useState<AdsCallToAction>(
    brief?.callToAction ?? "LEARN_MORE",
  );

  const input: Partial<AdsBriefInput> & Record<string, unknown> = {
    creativeId: creativeId ?? undefined,
    objective,
    dailyBudget: numberOf(budget),
    days,
    countries,
    ageMin: numberOf(ageMin),
    ageMax: numberOf(ageMax),
    gender,
    link: withScheme(link),
    callToAction: cta,
  };
  const issue = briefIssue(input);
  const daily = numberOf(budget);
  const total =
    Number.isFinite(daily) && daily > 0
      ? formatBudget(normalizeBudget(daily * days, currency), currency)
      : null;

  const buttons: CardButton[] = [
    {
      id: "brief:next",
      label: COPY.next,
      emphasis: "primary",
      action: { kind: "server", id: "brief:next" },
      disabledReason: gate ?? issue ?? undefined,
    },
  ];

  const budgetId = `${baseId}-budget`;
  const linkId = `${baseId}-link`;
  const ageMinId = `${baseId}-age-min`;
  const ageMaxId = `${baseId}-age-max`;

  return (
    <div className="space-y-4">
      <Section label={COPY.post}>
        <PostPicker
          posts={options.posts}
          value={creativeId}
          onChange={setCreativeId}
        />
      </Section>

      <Section label={COPY.goal}>
        <div
          role="radiogroup"
          aria-label={COPY.goal}
          className="grid grid-cols-1 gap-1.5 sm:grid-cols-3"
        >
          {ADS_OBJECTIVES.map((key) => {
            const meta = ADS_OBJECTIVE_META[key];
            const on = objective === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setObjective(key)}
                className="flex min-h-11 items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
                style={{
                  borderColor: on ? "var(--ws-accent)" : "var(--ws-border)",
                }}
              >
                <span className="min-w-0 flex-1">
                  <span
                    className="block text-sm font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {meta.label}
                  </span>
                  <span
                    className="block text-xs"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    {meta.hint}
                  </span>
                </span>
                {on ? (
                  <Check
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        label={currency ? `${COPY.budget} (${currency})` : COPY.budget}
        htmlFor={budgetId}
        hint={total ? COPY.total(total) : undefined}
      >
        <div className="space-y-2">
          <input
            id={budgetId}
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="10"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            className={`${FIELD_CLASS} max-w-40`}
            style={FIELD_STYLE}
          />
          <div
            role="group"
            aria-label={COPY.duration}
            className="flex flex-wrap items-center gap-1.5"
          >
            <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {COPY.duration}
            </span>
            {ADS_DURATIONS.map((value) => (
              <Chip
                key={value}
                active={days === value}
                onClick={() => setDays(value)}
              >
                {COPY.days(value)}
              </Chip>
            ))}
          </div>
        </div>
      </Section>

      <Section label={COPY.audience}>
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {COPY.countries}
            </span>
            <GeoTargetSelect value={countries} onChange={setCountries} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor={ageMinId} className="space-y-1">
              <span
                className="block text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.ageFrom}
              </span>
              <input
                id={ageMinId}
                type="number"
                inputMode="numeric"
                min={ADS_LIMITS.minAge}
                max={ADS_LIMITS.maxAge}
                value={ageMin}
                onChange={(event) => setAgeMin(event.target.value)}
                className={`${FIELD_CLASS} w-20`}
                style={FIELD_STYLE}
              />
            </label>
            <label htmlFor={ageMaxId} className="space-y-1">
              <span
                className="block text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.ageTo}
              </span>
              <input
                id={ageMaxId}
                type="number"
                inputMode="numeric"
                min={ADS_LIMITS.minAge}
                max={ADS_LIMITS.maxAge}
                value={ageMax}
                onChange={(event) => setAgeMax(event.target.value)}
                className={`${FIELD_CLASS} w-20`}
                style={FIELD_STYLE}
              />
            </label>
            <div className="space-y-1">
              <span
                className="block text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.gender}
              </span>
              <GenderToggle
                value={genderToggleValue(gender)}
                onChange={(value) => setGender(genderFromToggle(value))}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section label={COPY.link} htmlFor={linkId}>
        <input
          id={linkId}
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://"
          maxLength={ADS_LIMITS.link}
          value={link}
          onChange={(event) => setLink(event.target.value)}
          onBlur={() => setLink((value) => withScheme(value))}
          className={FIELD_CLASS}
          style={FIELD_STYLE}
        />
      </Section>

      <Section label={COPY.button}>
        <div
          role="group"
          aria-label={COPY.button}
          className="flex flex-wrap gap-1.5"
        >
          {ADS_CTAS.map((value) => (
            <Chip
              key={value}
              active={cta === value}
              onClick={() => setCta(value)}
            >
              {ADS_CTA_LABEL[value]}
            </Chip>
          ))}
        </div>
      </Section>

      <CardActions
        buttons={buttons}
        busyId={actions.busyId}
        error={actions.error}
        onAct={() => onNext(input)}
      />
    </div>
  );
}

// The posts an ad can be made from: thumbnail and title, one picked.
function PostPicker({
  posts,
  value,
  onChange,
}: {
  posts: readonly AdsSourcePost[];
  value: string | null;
  onChange: (creativeId: string) => void;
}) {
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {posts.map((post) => {
        const on = post.creativeId === value;
        return (
          <li key={post.creativeId} className="min-w-0">
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onChange(post.creativeId)}
              data-post={post.creativeId}
              className="w-full space-y-1 rounded-xl border p-1 text-left transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
              style={{
                borderColor: on ? "var(--ws-accent)" : "var(--ws-border)",
              }}
            >
              <span
                className="relative block aspect-square overflow-hidden rounded-lg"
                style={{ background: "var(--ws-hover)" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
                <img
                  src={assetUrl(post.assetId, "thumb")}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="size-full object-cover"
                />
                {post.channel ? (
                  <span className="absolute bottom-1 left-1">
                    <ChannelMark
                      channel={post.channel}
                      decorative
                      className="size-4"
                    />
                  </span>
                ) : null}
                {on ? (
                  <span
                    className="absolute top-1 right-1 grid size-5 place-items-center rounded-full"
                    style={{
                      background: "var(--ws-accent)",
                      color: "var(--ws-on-accent)",
                    }}
                  >
                    <Check aria-hidden="true" className="size-3" />
                  </span>
                ) : null}
              </span>
              <span
                className="block truncate px-0.5 text-[11px]"
                style={{ color: on ? "var(--ws-text)" : "var(--ws-text-2)" }}
              >
                {post.title}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
