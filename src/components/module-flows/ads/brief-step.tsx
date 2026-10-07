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
  ADS_MESSAGE_APP_LABEL,
  ADS_OBJECTIVES,
  ADS_OBJECTIVE_META,
  ADS_REPLY_TIMES,
  ADS_REPLY_TIME_LABEL,
  DEFAULT_ADS_DURATION,
  DEFAULT_AGE_MAX,
  DEFAULT_AGE_MIN,
  briefIssue,
  formatBudget,
  genderFromToggle,
  genderToggleValue,
  normalizeBudget,
  withScheme,
  targetsEuEea,
  type AdsBrief,
  type AdsBriefInput,
  type AdsBriefOptions,
  type AdsCallToAction,
  type AdsDuration,
  type AdsFlowState,
  type AdsGender,
  type AdsMessageApp,
  type AdsObjective,
  type AdsReplyTime,
  type AdsSourcePost,
} from "@/lib/module-flows/ads/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  learningBudget,
  learningFeasible,
  targetCost,
} from "@/lib/ads/kpi";
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
  // F5a: mesaj hedefi Engagement amacıyla, CONVERSATIONS olayıyla kurulur.
  const messageApps = options.goals?.messageApps ?? [];
  const [messagesOn, setMessagesOn] = useState(Boolean(brief?.messages));
  const [profileOn, setProfileOn] = useState(
    brief?.trafficEvent === "PROFILE_VISITS",
  );
  const [messageApp, setMessageApp] = useState<AdsMessageApp>(
    brief?.messages?.app ?? messageApps[0] ?? "WHATSAPP",
  );
  const [whatsappNumber, setWhatsappNumber] = useState(
    brief?.messages?.whatsappNumber ?? "",
  );
  const [replyTime, setReplyTime] = useState<AdsReplyTime>(
    brief?.messages?.replyTime ?? "hour",
  );
  const messages = messagesOn && options.goals?.messages;
  // Instagram profil ziyareti: trafik amacı, bağlantı yok (profil bağlantısı
  // sunucuda kurulur); mesajla birlikte olmaz.
  const profile = !messages && profileOn && options.goals?.instagramProfile;
  // F5b (planner açıkken): kitle modu, bütçe modu, KPI, ek postlar, mevcut
  // ad set.
  const planner = Boolean(options.goals);
  const [audienceMode, setAudienceMode] = useState<"suggest" | "limit">(
    brief?.audienceMode ?? (planner ? "suggest" : "limit"),
  );
  const [budgetMode, setBudgetMode] = useState<"daily" | "fixed">(
    brief?.budgetMode ?? "daily",
  );
  const [kpiMode, setKpiMode] = useState<"none" | "value" | "max">(
    brief?.kpi?.mode ?? "none",
  );
  const [saleValue, setSaleValue] = useState(
    brief?.kpi?.mode === "value" ? String(brief.kpi.saleValue) : "",
  );
  const [closeOutOfTen, setCloseOutOfTen] = useState(
    brief?.kpi?.mode === "value" ? String(brief.kpi.closeOutOfTen) : "",
  );
  const [maxCost, setMaxCost] = useState(
    brief?.kpi?.mode === "max" ? String(brief.kpi.maxCost) : "",
  );
  const [extraIds, setExtraIds] = useState<string[]>(
    brief?.extraSources?.map((source) => source.creativeId) ?? [],
  );
  const [videoId, setVideoId] = useState<string | null>(
    brief?.video?.assetId ?? null,
  );
  const [hoursOn, setHoursOn] = useState(Boolean(brief?.hours));
  const [hoursFrom, setHoursFrom] = useState(String(brief?.hours?.from ?? 9));
  const [hoursTo, setHoursTo] = useState(String(brief?.hours?.to ?? 18));
  const [weekdaysOnly, setWeekdaysOnly] = useState(
    brief?.hours?.weekdaysOnly ?? true,
  );
  const [adFormat, setAdFormat] = useState<"single" | "carousel">(
    brief?.adFormat === "carousel" ? "carousel" : "single",
  );
  const [existingAdSetId, setExistingAdSetId] = useState(
    brief?.existingAdSetId ?? "",
  );
  const adding = planner && Boolean(existingAdSetId);
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
  // DSA: istenir yalnız AB/AEA hedefinde; Sayfa adı makul ilk değerdir.
  const [dsaBeneficiary, setDsaBeneficiary] = useState(
    brief?.dsaBeneficiary ?? options.account.pageName ?? "",
  );
  const [dsaPayor, setDsaPayor] = useState(
    brief?.dsaPayor ?? options.account.pageName ?? "",
  );
  const showDsa = targetsEuEea(countries);

  const trafficEvent = profile
    ? ("PROFILE_VISITS" as const)
    : objective === "OUTCOME_TRAFFIC" && options.goals?.landingPageViews
      ? ("LANDING_PAGE_VIEWS" as const)
      : undefined;
  const budgetNumber = numberOf(budget);
  const enteredDaily =
    planner && budgetMode === "fixed" ? budgetNumber / days : budgetNumber;
  const kpi =
    kpiMode === "value" && numberOf(saleValue) > 0 && numberOf(closeOutOfTen) > 0
      ? {
          mode: "value" as const,
          saleValue: numberOf(saleValue),
          closeOutOfTen: numberOf(closeOutOfTen),
        }
      : kpiMode === "max" && numberOf(maxCost) > 0
        ? { mode: "max" as const, maxCost: numberOf(maxCost) }
        : undefined;
  const target = targetCost(kpi);
  // Carousel yalnız bağlantılı hedeflerde (mesaj ve form değil); en az bir ek
  // post seçili olmalı.
  const carouselAllowed =
    planner && !messages && objective !== "OUTCOME_LEADS";
  const carouselOn =
    carouselAllowed && adFormat === "carousel" && extraIds.length > 0;
  const maxExtras = carouselAllowed && adFormat === "carousel" ? 9 : 2;
  // Video reklam tek reklamdır: ek post, carousel, mesaj ve formla olmaz.
  const videoAllowed =
    planner &&
    !messages &&
    objective !== "OUTCOME_LEADS" &&
    extraIds.length === 0 &&
    adFormat !== "carousel" &&
    Boolean(options.videos?.length);
  const videoActive =
    videoAllowed && options.videos?.some((video) => video.assetId === videoId);
  // Mesai saatleri yalnız toplam bütçeyle ve yeni kampanyada.
  const hoursAllowed = planner && budgetMode === "fixed" && !adding;
  const hoursActive = hoursAllowed && hoursOn;
  const input: Partial<AdsBriefInput> & Record<string, unknown> = {
    creativeId: creativeId ?? undefined,
    objective: messages
      ? "OUTCOME_ENGAGEMENT"
      : profile
        ? "OUTCOME_TRAFFIC"
        : objective,
    // Mevcut ad set'e eklemede bütçe o ad set'indir (bu değer kullanılmaz).
    dailyBudget:
      adding && !(Number.isFinite(enteredDaily) && enteredDaily > 0)
        ? 1
        : enteredDaily,
    days,
    countries,
    ageMin: numberOf(ageMin),
    ageMax: numberOf(ageMax),
    gender,
    link: messages || profile ? "" : withScheme(link),
    callToAction: cta,
    ...(showDsa ? { dsaBeneficiary, dsaPayor } : {}),
    ...(messages
      ? {
          messages: {
            app: messageApp,
            ...(messageApp === "WHATSAPP" && whatsappNumber.trim()
              ? { whatsappNumber: whatsappNumber.trim() }
              : {}),
            replyTime,
          },
        }
      : {}),
    ...(trafficEvent && !messages ? { trafficEvent } : {}),
    ...(planner ? { audienceMode } : {}),
    ...(planner && budgetMode === "fixed" ? { budgetMode } : {}),
    ...(kpi && !adding ? { kpi } : {}),
    ...(planner && extraIds.length > 0
      ? { extraCreativeIds: extraIds.filter((id) => id !== creativeId) }
      : {}),
    ...(carouselOn ? { adFormat: "carousel" as const } : {}),
    ...(videoActive && videoId ? { videoAssetId: videoId } : {}),
    ...(hoursActive
      ? {
          hours: {
            from: Number(hoursFrom),
            to: Number(hoursTo),
            weekdaysOnly,
          },
        }
      : {}),
    ...(adding ? { existingAdSetId } : {}),
  };
  const issue = briefIssue(input);
  const daily = enteredDaily;
  const total =
    Number.isFinite(daily) && daily > 0
      ? formatBudget(normalizeBudget(daily * days, currency), currency)
      : null;
  const feasibilityNote =
    target && Number.isFinite(daily) && daily > 0 && !learningFeasible(daily, target)
      ? COPY.feasibility(formatBudget(learningBudget(target), currency))
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
  const dsaBeneficiaryId = `${baseId}-dsa-beneficiary`;
  const dsaPayorId = `${baseId}-dsa-payor`;
  const minAgeId = `${baseId}-age-min`;
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

      {planner && options.posts.length > 1 ? (
        <Section label={COPY.morePosts} hint={COPY.morePostsHint}>
          <div role="group" aria-label={COPY.morePosts} className="flex flex-wrap gap-1.5">
            {options.posts
              .filter((post) => post.creativeId !== creativeId)
              .slice(0, 11)
              .map((post) => {
                const on = extraIds.includes(post.creativeId);
                return (
                  <Chip
                    key={post.creativeId}
                    active={on}
                    onClick={() =>
                      setExtraIds((ids) =>
                        on
                          ? ids.filter((id) => id !== post.creativeId)
                          : ids.length >= maxExtras
                            ? ids
                            : [...ids, post.creativeId],
                      )
                    }
                  >
                    {post.title || COPY.post}
                  </Chip>
                );
              })}
          </div>
        </Section>
      ) : null}

      {videoAllowed ? (
        <Section label={COPY.videoLabel} hint={COPY.videoHint}>
          <div
            role="group"
            aria-label={COPY.videoLabel}
            className="flex flex-wrap gap-1.5"
          >
            <Chip active={!videoActive} onClick={() => setVideoId(null)}>
              {COPY.pictureOnly}
            </Chip>
            {options.videos!.map((video) => (
              <Chip
                key={video.assetId}
                active={videoId === video.assetId}
                onClick={() => setVideoId(video.assetId)}
              >
                {video.name}
              </Chip>
            ))}
          </div>
        </Section>
      ) : null}

      {carouselAllowed && extraIds.length > 0 ? (
        <Section label={COPY.adFormat} hint={COPY.carouselHint}>
          <div
            role="group"
            aria-label={COPY.adFormat}
            className="flex flex-wrap gap-1.5"
          >
            <Chip
              active={adFormat === "single"}
              onClick={() => setAdFormat("single")}
            >
              {COPY.separateAds}
            </Chip>
            <Chip
              active={adFormat === "carousel"}
              onClick={() => setAdFormat("carousel")}
            >
              {COPY.carouselAd}
            </Chip>
          </div>
        </Section>
      ) : null}

      {planner && options.adSets?.length ? (
        <Section label={COPY.where}>
          <div className="space-y-2">
            <div role="group" aria-label={COPY.where} className="flex flex-wrap gap-1.5">
              <Chip active={!adding} onClick={() => setExistingAdSetId("")}>
                {COPY.newCampaign}
              </Chip>
              <Chip
                active={adding}
                onClick={() => setExistingAdSetId(options.adSets![0]!.id)}
              >
                {COPY.addToAdSet}
              </Chip>
            </div>
            {adding ? (
              <>
                <select
                  aria-label={COPY.addToAdSet}
                  value={existingAdSetId}
                  onChange={(event) => setExistingAdSetId(event.target.value)}
                  className={FIELD_CLASS}
                  style={FIELD_STYLE}
                >
                  {options.adSets.map((adSet) => (
                    <option key={adSet.id} value={adSet.id}>
                      {adSet.campaignName ? `${adSet.campaignName} · ${adSet.name}` : adSet.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                  {COPY.addToAdSetHint}
                </p>
              </>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section label={COPY.goal}>
        <div
          role="radiogroup"
          aria-label={COPY.goal}
          className="grid grid-cols-1 gap-1.5 sm:grid-cols-3"
        >
          {ADS_OBJECTIVES.map((key) => {
            const meta = ADS_OBJECTIVE_META[key];
            const on = !messages && !profile && objective === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setMessagesOn(false);
                  setProfileOn(false);
                  setObjective(key);
                }}
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
          {options.goals?.messages ? (
            <button
              type="button"
              role="radio"
              aria-checked={Boolean(messages)}
              onClick={() => {
                setProfileOn(false);
                setMessagesOn(true);
              }}
              className="flex min-h-11 items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
              style={{
                borderColor: messages ? "var(--ws-accent)" : "var(--ws-border)",
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium" style={{ color: "var(--ws-text)" }}>
                  {COPY.messagesGoal}
                </span>
                <span className="block text-xs" style={{ color: "var(--ws-text-2)" }}>
                  {COPY.messagesHint}
                </span>
              </span>
              {messages ? <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
            </button>
          ) : null}
          {options.goals?.instagramProfile ? (
            <button
              type="button"
              role="radio"
              aria-checked={Boolean(profile)}
              onClick={() => {
                setMessagesOn(false);
                setProfileOn(true);
              }}
              className="flex min-h-11 items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
              style={{
                borderColor: profile ? "var(--ws-accent)" : "var(--ws-border)",
              }}
            >
              <span className="min-w-0 flex-1">
                <span
                  className="block text-sm font-medium"
                  style={{ color: "var(--ws-text)" }}
                >
                  {COPY.profileGoal}
                </span>
                <span
                  className="block text-xs"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {COPY.profileHint}
                </span>
              </span>
              {profile ? (
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              ) : null}
            </button>
          ) : null}
        </div>
        {options.recommended ? (
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {COPY.recommended(
              options.recommended.goal === "MESSAGES" ? COPY.messagesGoal : ADS_OBJECTIVE_META.OUTCOME_TRAFFIC.label,
              options.recommended.reason,
            )}
          </p>
        ) : null}
        {!messages && !profile && objective === "OUTCOME_TRAFFIC" && options.goals ? (
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {options.goals.landingPageViews ? COPY.lpvOn : COPY.noPixel}
          </p>
        ) : null}
      </Section>

      {messages ? (
        <Section label={COPY.messagesWhere}>
          <div className="space-y-2">
            <div role="group" aria-label={COPY.messagesWhere} className="flex flex-wrap gap-1.5">
              {messageApps.map((app) => (
                <Chip key={app} active={messageApp === app} onClick={() => setMessageApp(app)}>
                  {ADS_MESSAGE_APP_LABEL[app]}
                </Chip>
              ))}
            </div>
            {messageApp === "WHATSAPP" ? (
              <label className="block space-y-1">
                <span className="block text-xs" style={{ color: "var(--ws-text-2)" }}>
                  {COPY.whatsappNumber}
                </span>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+90 5xx xxx xx xx"
                  maxLength={20}
                  value={whatsappNumber}
                  onChange={(event) => setWhatsappNumber(event.target.value)}
                  className={FIELD_CLASS}
                  style={FIELD_STYLE}
                />
              </label>
            ) : null}
            <div className="space-y-1">
              <span className="block text-xs" style={{ color: "var(--ws-text-2)" }}>
                {COPY.replyTime}
              </span>
              <div role="group" aria-label={COPY.replyTime} className="flex flex-wrap gap-1.5">
                {ADS_REPLY_TIMES.map((value) => (
                  <Chip key={value} active={replyTime === value} onClick={() => setReplyTime(value)}>
                    {ADS_REPLY_TIME_LABEL[value]}
                  </Chip>
                ))}
              </div>
            </div>
          </div>
        </Section>
      ) : null}

      {adding ? null : (
      <Section
        label={
          planner && budgetMode === "fixed"
            ? currency
              ? `${COPY.totalBudget} (${currency})`
              : COPY.totalBudget
            : currency
              ? `${COPY.budget} (${currency})`
              : COPY.budget
        }
        htmlFor={budgetId}
        hint={total ? COPY.total(total) : undefined}
      >
        <div className="space-y-2">
          {planner ? (
            <div role="group" aria-label={COPY.budgetMode} className="flex flex-wrap gap-1.5">
              <Chip active={budgetMode === "daily"} onClick={() => setBudgetMode("daily")}>
                {COPY.perDay}
              </Chip>
              <Chip active={budgetMode === "fixed"} onClick={() => setBudgetMode("fixed")}>
                {COPY.inTotal}
              </Chip>
            </div>
          ) : null}
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
          {feasibilityNote ? (
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {feasibilityNote}
            </p>
          ) : null}
        </div>
      </Section>
      )}

      {hoursAllowed ? (
        <Section label={COPY.hoursLabel} hint={COPY.hoursHint}>
          <div className="space-y-2">
            <div
              role="group"
              aria-label={COPY.hoursLabel}
              className="flex flex-wrap gap-1.5"
            >
              <Chip active={!hoursOn} onClick={() => setHoursOn(false)}>
                {COPY.allDay}
              </Chip>
              <Chip active={hoursOn} onClick={() => setHoursOn(true)}>
                {COPY.businessHours}
              </Chip>
            </div>
            {hoursOn ? (
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <span
                    className="block text-xs"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    {COPY.hoursFrom}
                  </span>
                  <select
                    value={hoursFrom}
                    onChange={(event) => setHoursFrom(event.target.value)}
                    className={FIELD_CLASS}
                    style={FIELD_STYLE}
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span
                    className="block text-xs"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    {COPY.hoursTo}
                  </span>
                  <select
                    value={hoursTo}
                    onChange={(event) => setHoursTo(event.target.value)}
                    className={FIELD_CLASS}
                    style={FIELD_STYLE}
                  >
                    {Array.from({ length: 24 }, (_, index) => index + 1).map(
                      (hour) => (
                        <option key={hour} value={hour}>
                          {String(hour).padStart(2, "0")}:00
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <div
                  role="group"
                  aria-label={COPY.weekdaysOnly}
                  className="flex flex-wrap gap-1.5"
                >
                  <Chip
                    active={weekdaysOnly}
                    onClick={() => setWeekdaysOnly(true)}
                  >
                    {COPY.weekdaysOnly}
                  </Chip>
                  <Chip
                    active={!weekdaysOnly}
                    onClick={() => setWeekdaysOnly(false)}
                  >
                    {COPY.everyDay}
                  </Chip>
                </div>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {planner && !adding ? (
        <Section label={COPY.target} hint={target ? COPY.targetIs(formatBudget(target, currency)) : COPY.targetHint}>
          <div className="space-y-2">
            <div role="group" aria-label={COPY.target} className="flex flex-wrap gap-1.5">
              <Chip active={kpiMode === "none"} onClick={() => setKpiMode("none")}>
                {COPY.targetSkip}
              </Chip>
              <Chip active={kpiMode === "value"} onClick={() => setKpiMode("value")}>
                {COPY.targetFromNumbers}
              </Chip>
              <Chip active={kpiMode === "max"} onClick={() => setKpiMode("max")}>
                {COPY.targetMax}
              </Chip>
            </div>
            {kpiMode === "value" ? (
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <span className="block text-xs" style={{ color: "var(--ws-text-2)" }}>
                    {COPY.saleValue}
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={saleValue}
                    onChange={(event) => setSaleValue(event.target.value)}
                    className={`${FIELD_CLASS} w-32`}
                    style={FIELD_STYLE}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs" style={{ color: "var(--ws-text-2)" }}>
                    {COPY.closeRate}
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={10}
                    step="any"
                    value={closeOutOfTen}
                    onChange={(event) => setCloseOutOfTen(event.target.value)}
                    className={`${FIELD_CLASS} w-20`}
                    style={FIELD_STYLE}
                  />
                </label>
              </div>
            ) : kpiMode === "max" ? (
              <label className="block space-y-1">
                <span className="block text-xs" style={{ color: "var(--ws-text-2)" }}>
                  {COPY.maxCost}
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={maxCost}
                  onChange={(event) => setMaxCost(event.target.value)}
                  className={`${FIELD_CLASS} w-32`}
                  style={FIELD_STYLE}
                />
              </label>
            ) : null}
          </div>
        </Section>
      ) : null}

      {adding ? null : (
      <Section label={COPY.audience}>
        <div className="space-y-3">
          {planner ? (
            <div className="space-y-1">
              <div role="group" aria-label={COPY.audienceMode} className="flex flex-wrap gap-1.5">
                <Chip active={audienceMode === "suggest"} onClick={() => setAudienceMode("suggest")}>
                  {COPY.suggest}
                </Chip>
                <Chip active={audienceMode === "limit"} onClick={() => setAudienceMode("limit")}>
                  {COPY.limitTo}
                </Chip>
              </div>
              <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                {audienceMode === "suggest" ? COPY.suggestHint : COPY.limitHint}
              </p>
            </div>
          ) : null}
          <div className="space-y-1">
            <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {COPY.countries}
            </span>
            <GeoTargetSelect value={countries} onChange={setCountries} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor={minAgeId} className="space-y-1">
              <span
                className="block text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.ageFrom}
              </span>
              <input
                id={minAgeId}
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
      )}

      {showDsa ? (
        <Section label={COPY.dsa}>
          <div className="space-y-2">
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {COPY.dsaHint}
            </p>
            <label htmlFor={dsaBeneficiaryId} className="block space-y-1">
              <span
                className="block text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.dsaBeneficiary}
              </span>
              <input
                id={dsaBeneficiaryId}
                maxLength={512}
                value={dsaBeneficiary}
                onChange={(event) => setDsaBeneficiary(event.target.value)}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              />
            </label>
            <label htmlFor={dsaPayorId} className="block space-y-1">
              <span
                className="block text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.dsaPayor}
              </span>
              <input
                id={dsaPayorId}
                maxLength={512}
                value={dsaPayor}
                onChange={(event) => setDsaPayor(event.target.value)}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              />
            </label>
          </div>
        </Section>
      ) : null}

      {messages || profile ? null : (
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

      )}

      {messages || profile ? null : (
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
      )}

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
