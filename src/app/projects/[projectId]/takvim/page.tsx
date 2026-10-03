import { Suspense } from "react";
import { notFound } from "next/navigation";

import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { loadCalendarData } from "@/server/calendar/load-calendar";
import { loadCreativeLocalDay } from "@/server/calendar/load-detail";
import { getProjectTimezone } from "@/server/chat/content-plan";
import {
  buildCalendarRange,
  switchViewNav,
  weekdayMonFirst,
  type CalendarNav,
} from "@/lib/calendar/grid";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import type { NextStep } from "@/lib/journey";
import { NextStepBanner } from "@/components/commands/next-step-banner";
import { computeNextSteps } from "@/server/agency/journey/next-steps";
import { loadJourneySnapshot } from "@/server/agency/journey/snapshot";
import { workIdOfStep } from "@/server/agency/journey/step-work";
import { isWorksEnabled } from "@/server/works/flag";
import { AppShell } from "@/components/layout/app-shell";
import {
  CalendarBoard,
  type BoardDay,
  type BoardHrefs,
} from "@/components/calendar/calendar-board";

// Content Calendar (spec: takvim) — projenin içeriklerini gün gün gösterir,
// sürükle-bırakla günlerini değiştirir ve her parçanın ne durumda olduğunu
// (onay bekliyor, zamanlandı, yayınlanıyor, yayınlandı, hata...) tek bakışta
// söyler. Sayfa RSC'dir ve YALNIZ ilk yüklemede çalışır: erişim, ilk veri ve
// durum hesabı burada; sonrası istemcide. Kart açmak, bir parçayı taşımak ve
// 30 sn'lik tazeleme sayfayı yeniden render ETMEZ (kenar çubuğu, journey
// snapshot... onlarca sorgu demekti); hafif uçlar kullanılır
// (/api/projects/[id]/calendar ve .../[creativeId]). Ay/hafta gezintisi URL'de
// durur (`?view=week&date=`, `?month=`), açık kart `?creative=` ile paylaşılır.
//
// Parçanın oluşturulma tarihine/görevine dokunulmaz; yalnızca HANGİ GÜN+SAATTE
// yayınlanacağı (Creative.scheduledFor) değişir. Izgara saf Gregoryen takvim
// aritmetiğidir (src/lib/calendar/grid.ts); bir scheduledFor anının hangi güne
// düştüğü ise projenin saat dilimine göre hesaplanır (src/lib/timezone.ts).

function calendarHref(
  base: string,
  nav: CalendarNav,
  channel: string | undefined,
): string {
  const search = new URLSearchParams();
  if (nav.view === "week") search.set("view", "week");
  if (nav.month) search.set("month", nav.month);
  if (nav.date) search.set("date", nav.date);
  if (channel) search.set("channel", channel);
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

function first(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ContentCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const { userId } = await requireUser();

  // Erişim, kabuktan ÖNCE: üye olmayan biri için kenar çubuğu rozetleri bile
  // hesaplanmaz.
  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (
      isAgentelseError(error) &&
      (error.code === "NOT_FOUND" || error.code === "PERMISSION_DENIED")
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <AppShell projectId={projectId}>
      <div className="space-y-5 p-4 pb-16 md:p-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Content Calendar
          </h1>
          <p className="text-sm text-muted-foreground">
            Drag a piece to a new day, see what&apos;s posted and what needs you
          </p>
        </div>
        {/* Kabuk ve başlık hemen çıkar; takvim verisi hazır olunca akar. */}
        <Suspense fallback={<CalendarSkeleton />}>
          <CalendarContent projectId={projectId} sp={sp} />
        </Suspense>
      </div>
    </AppShell>
  );
}

// "Sıradaki adım" şeridi takvimi BEKLETMEZ: journey snapshot'ı pahalıdır
// (300 satırlık okuma, kanal bağlantıları, sonuçlar). İşi takvim verisiyle
// paralel başlatılır, şerit hazır olunca kendi başına akar.
async function loadNextStep(
  projectId: string,
): Promise<{ step: NextStep; workId: string | undefined } | null> {
  try {
    const snapshot = await loadJourneySnapshot(projectId);
    const step = snapshot ? computeNextSteps(snapshot)[0] : undefined;
    if (!snapshot || !step) return null;
    // Works açıkken şerit planı taşıyan sohbeti açar: çıplak proje adresi yeni
    // sohbet başlatır, adım orada hiçbir şey çalıştırmaz.
    const workId = isWorksEnabled()
      ? await workIdOfStep(projectId, snapshot, step)
      : undefined;
    return { step, workId };
  } catch {
    return null;
  }
}

async function NextStepSlot({
  projectId,
  pending,
}: {
  projectId: string;
  pending: ReturnType<typeof loadNextStep>;
}) {
  const next = await pending;
  if (!next) return null;
  return (
    <NextStepBanner
      projectId={projectId}
      step={next.step}
      workId={next.workId}
    />
  );
}

async function CalendarContent({
  projectId,
  sp,
}: {
  projectId: string;
  sp: SearchParams;
}) {
  const nextStep = loadNextStep(projectId);

  const timezone = await getProjectTimezone(projectId);
  const todayKey = dayKeyInTimezone(new Date(), timezone);
  // `?creative=` ile gelen bağlantı (ör. plan panelindeki "Open post") o
  // parçanın ayını/haftasını açar; yoksa parça görünür aralığın dışında kalır.
  const creativeId = first(sp.creative);
  const creativeDay =
    creativeId && !sp.month && !sp.date
      ? await loadCreativeLocalDay(projectId, creativeId, timezone)
      : null;
  const range = buildCalendarRange({
    view: first(sp.view),
    month: first(sp.month) ?? creativeDay?.slice(0, 7),
    date: first(sp.date) ?? creativeDay ?? undefined,
    todayKey,
  });
  const base = `/projects/${projectId}/takvim`;
  const sourceParam = first(sp.channel);
  const initialSource =
    sourceParam && /^[a-z]{1,16}$/.test(sourceParam) ? sourceParam : undefined;

  const data = await loadCalendarData({
    projectId,
    timezone,
    from: zonedDateTimeToUtc(`${range.firstKey}T00:00`, timezone),
    // Son günün 23:59:59'una kadar.
    to: new Date(
      zonedDateTimeToUtc(`${range.lastKey}T23:59`, timezone).getTime() + 59_999,
    ),
  });

  // Adresteki geçerli konum: kart adresleri aynı aya/haftaya bağlı kalır.
  const here: CalendarNav =
    range.view === "week"
      ? { view: "week", date: first(sp.date) }
      : { view: "month", month: first(sp.month) };
  const href = (nav: CalendarNav) => calendarHref(base, nav, initialSource);
  const hereHref = href(here);
  const hrefs: BoardHrefs = {
    prev: href(range.prev),
    next: href(range.next),
    today: href(range.today),
    // Zaten bulunulan görünüme tıklamak konumu bozmaz.
    month: href(
      range.view === "month" ? here : switchViewNav(range, "month", todayKey),
    ),
    week: href(
      range.view === "week" ? here : switchViewNav(range, "week", todayKey),
    ),
    creativePrefix: `${hereHref}${hereHref.includes("?") ? "&" : "?"}creative=`,
    integrations: `/projects/${projectId}/integrations`,
    settings: `/projects/${projectId}/ayarlar`,
    chat: `/projects/${projectId}`,
  };

  const days: BoardDay[] = range.days.map((d) => ({
    key: d.key,
    day: d.day,
    month: d.month,
    weekday: weekdayMonFirst(d.year, d.month, d.day),
  }));

  return (
    <>
      {/* Banner yüksekliğinde yer tutucu: gelince takvim aşağı kaymasın. */}
      <Suspense
        fallback={
          <div className="h-[52px] rounded-xl bg-muted/30" aria-hidden />
        }
      >
        <NextStepSlot projectId={projectId} pending={nextStep} />
      </Suspense>
      <CalendarBoard
        projectId={projectId}
        timezone={timezone}
        todayKey={todayKey}
        view={range.view}
        title={range.title}
        days={days}
        focusMonth={range.focusMonth}
        isCurrent={range.isCurrent}
        hrefs={hrefs}
        data={data}
        initialOpenId={creativeId}
        initialSource={initialSource}
      />
    </>
  );
}

function CalendarSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="h-8 w-72 animate-pulse rounded-lg bg-muted/60" />
      <div className="h-7 w-96 max-w-full animate-pulse rounded-full bg-muted/40" />
      <div className="h-[34rem] animate-pulse rounded-xl bg-muted/30" />
    </div>
  );
}
