"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { ContentPlanListView } from "@/components/search-content-plan/content-plan-list";
import type { ContentPlanView } from "@/server/seo/content-plan/store";

// SEO yol haritası kartındaki canlı "This month's articles" bloğu (SC-F7,
// docs/search-content-plan.md). Geçmiş ayın yol haritası değişmez bir anlık
// görüntüdür: canlı plan YALNIZ istenen ay projenin şimdiki yerel ayına eşitse
// çizilir. Yükleniyor, bayrak kapalı (404), hata, plan yok ya da ay uyuşmazlığı
// durumlarında mevcut anlık görüntü bölümü (fallback) aynen kalır; hiçbir
// durumda fırlatmaz. Saf görünüm ayrıdır (Node'da test edilir).

export type ThisMonthsArticlesLiveState =
  | "idle"
  | "loading"
  | "error"
  | "off"
  | { plan: ContentPlanView | null; currentMonth: string };

export function ThisMonthsArticlesLiveView({
  state,
  month,
  fallback,
  projectId,
}: {
  state: ThisMonthsArticlesLiveState;
  month: string;
  fallback: ReactNode;
  projectId: string;
}): React.JSX.Element {
  if (
    typeof state === "object" &&
    state.plan !== null &&
    state.currentMonth === month &&
    state.plan.state === "ready"
  ) {
    return (
      <div data-live="true">
        <ContentPlanListView view={state.plan} compact projectId={projectId} />
      </div>
    );
  }
  return <>{fallback}</>;
}

// Yanıtın biçimi gevşekçe doğrulanır; bozuksa "error" sayılır.
function parseResponse(
  body: unknown,
): { plan: ContentPlanView | null; currentMonth: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.currentMonth !== "string") return null;
  const plan = record.plan;
  if (plan === null) return { plan: null, currentMonth: record.currentMonth };
  if (typeof plan !== "object" || plan === undefined) return null;
  const candidate = plan as Partial<ContentPlanView>;
  if (!Array.isArray(candidate.slots) || typeof candidate.month !== "string") {
    return null;
  }
  return { plan: candidate as ContentPlanView, currentMonth: record.currentMonth };
}

export function ThisMonthsArticlesLive({
  projectId,
  month,
  fallback,
}: {
  projectId: string;
  month: string;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<ThisMonthsArticlesLiveState>("idle");
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    const controller = new AbortController();
    let started = false;

    async function load() {
      if (started) return;
      started = true;
      setState("loading");
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/search/content-plan?month=${encodeURIComponent(month)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (response.status === 404) {
          setState("off");
          return;
        }
        if (!response.ok) {
          setState("error");
          return;
        }
        const parsed = parseResponse(await response.json());
        setState(parsed ?? "error");
      } catch {
        if (!controller.signal.aborted) setState("error");
      }
    }

    if (!element || typeof IntersectionObserver === "undefined") {
      void load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [projectId, month]);

  return (
    <div ref={host}>
      <ThisMonthsArticlesLiveView
        state={state}
        month={month}
        fallback={fallback}
        projectId={projectId}
      />
    </div>
  );
}
