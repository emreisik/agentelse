"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Heart, MessageCircle } from "lucide-react";

import {
  INSIGHTS_WINDOW_DAYS,
  engagementRate,
  formatCount,
  formatRate,
  type InstagramOverview,
} from "@/lib/instagram-overview";

// The right panel's Instagram card: the connected account's profile numbers,
// how its last weeks went (reach, views, engagement) and its latest posts.
// Read after the page has rendered, through the overview endpoint, so a slow
// Meta answer never holds the workspace up. Shown only while Instagram is
// connected; the "Bağlı hesaplar" card already says when it is not.

const CARD_CLASS = "rounded-xl border p-3.5";
const CARD_STYLE = {
  borderColor: "var(--ws-border)",
  background: "var(--ws-surface)",
} as const;

export type LoadState =
  | { status: "loading" }
  | { status: "done"; overview: InstagramOverview };

function useInstagramOverview(projectId: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/instagram/overview`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const overview = (await res.json()) as InstagramOverview;
        setState({ status: "done", overview });
      } catch {
        if (controller.signal.aborted) return;
        setState({
          status: "done",
          overview: { ok: false, reason: "error" },
        });
      }
    })();
    return () => controller.abort();
  }, [projectId]);

  return state;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p
        className="truncate text-sm font-semibold tabular-nums"
        style={{ color: "var(--ws-text)" }}
      >
        {value}
      </p>
      <p className="truncate text-[10px]" style={{ color: "var(--ws-text-3)" }}>
        {label}
      </p>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2.5 text-[11px] leading-snug" style={{ color: "var(--ws-text-2)" }}>
      {children}
    </p>
  );
}

function Skeleton() {
  return (
    <div aria-hidden className="mt-3 animate-pulse space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="size-10 rounded-full" style={{ background: "var(--ws-surface-2)" }} />
        <div className="h-3 w-28 rounded" style={{ background: "var(--ws-surface-2)" }} />
      </div>
      <div className="h-10 rounded-lg" style={{ background: "var(--ws-surface-2)" }} />
      <div className="h-16 rounded-lg" style={{ background: "var(--ws-surface-2)" }} />
    </div>
  );
}

export function InstagramOverviewCard({ projectId }: { projectId: string }) {
  return (
    <InstagramOverviewView
      projectId={projectId}
      state={useInstagramOverview(projectId)}
    />
  );
}

// The card for a given load state, apart from the fetching, so every state
// can be rendered and checked on its own.
export function InstagramOverviewView({
  projectId,
  state,
}: {
  projectId: string;
  state: LoadState;
}) {
  const integrationsHref = `/projects/${projectId}/integrations`;

  // Not connected: nothing to show here.
  if (
    state.status === "done" &&
    !state.overview.ok &&
    state.overview.reason === "not_connected"
  ) {
    return null;
  }

  return (
    <section
      aria-label="Instagram"
      data-card="instagram-overview"
      className={CARD_CLASS}
      style={CARD_STYLE}
    >
      <h2 className="text-sm font-semibold" style={{ color: "var(--ws-text)" }}>
        Instagram
      </h2>

      {state.status === "loading" ? <Skeleton /> : null}

      {state.status === "done" && !state.overview.ok ? (
        <Note>
          {state.overview.reason === "expired" ? (
            <>
              Bağlantının süresi dolmuş.{" "}
              <Link
                href={integrationsHref}
                className="underline underline-offset-2"
                style={{ color: "var(--ws-text)" }}
              >
                Instagram&apos;ı yeniden bağlayın
              </Link>
              .
            </>
          ) : (
            "Instagram verisi şu an okunamadı."
          )}
        </Note>
      ) : null}

      {state.status === "done" && state.overview.ok ? (
        <Loaded overview={state.overview} integrationsHref={integrationsHref} />
      ) : null}
    </section>
  );
}

function Loaded({
  overview,
  integrationsHref,
}: {
  overview: Extract<InstagramOverview, { ok: true }>;
  integrationsHref: string;
}) {
  const { profile, insights, insightsMissing, posts } = overview;
  const rate = engagementRate(posts, profile.followers);
  const title = profile.name || (profile.username ? `@${profile.username}` : "Instagram");

  return (
    <>
      <div
        className="mt-3 flex items-center gap-2.5 border-b pb-3"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <span
          className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full"
          style={{ background: "var(--ws-surface-2)", color: "var(--ws-text)" }}
        >
          {profile.pictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN URL, next/image can't optimize it
            <img
              src={profile.pictureUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="size-full object-cover"
            />
          ) : (
            <span className="text-sm font-bold">IG</span>
          )}
        </span>
        <div className="min-w-0">
          <p
            className="truncate text-xs font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {title}
          </p>
          {profile.username && profile.name ? (
            <p className="truncate text-[11px]" style={{ color: "var(--ws-text-3)" }}>
              @{profile.username}
            </p>
          ) : null}
        </div>
      </div>

      <div
        className="grid grid-cols-3 gap-2 border-b py-3"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <Stat label="Takipçi" value={formatCount(profile.followers)} />
        <Stat label="Takip edilen" value={formatCount(profile.follows)} />
        <Stat label="Gönderi" value={formatCount(profile.posts)} />
      </div>

      <div className="border-b py-3" style={{ borderColor: "var(--ws-border)" }}>
        <p className="mb-2 text-[11px]" style={{ color: "var(--ws-text-3)" }}>
          Son {INSIGHTS_WINDOW_DAYS} gün
        </p>
        {insights ? (
          <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
            <Stat label="Erişilen hesap" value={formatCount(insights.reach)} />
            <Stat label="Görüntülenme" value={formatCount(insights.views)} />
            <Stat
              label="Etkileşime giren hesap"
              value={formatCount(insights.accounts_engaged)}
            />
            <Stat
              label="Toplam etkileşim"
              value={formatCount(insights.total_interactions)}
            />
          </div>
        ) : insightsMissing === "permission" ? (
          <p className="text-[11px] leading-snug" style={{ color: "var(--ws-text-2)" }}>
            Erişim ve görüntülenme için ek izin gerekiyor.{" "}
            <Link
              href={integrationsHref}
              className="underline underline-offset-2"
              style={{ color: "var(--ws-text)" }}
            >
              Instagram&apos;ı yeniden bağlayın
            </Link>
            .
          </p>
        ) : (
          <p className="text-[11px]" style={{ color: "var(--ws-text-2)" }}>
            Erişim verisi şu an okunamadı.
          </p>
        )}
        <div className="mt-2.5">
          <Stat
            label={`Etkileşim oranı (son ${posts.length} gönderi, takipçiye göre)`}
            value={formatRate(rate)}
          />
        </div>
      </div>

      {posts.length > 0 ? (
        <div className="pt-3">
          <p className="mb-2 text-[11px]" style={{ color: "var(--ws-text-3)" }}>
            Son gönderiler
          </p>
          <ul className="grid grid-cols-3 gap-1.5">
            {posts.map((post) => (
              <li key={post.id}>
                <PostTile post={post} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function PostTile({
  post,
}: {
  post: Extract<InstagramOverview, { ok: true }>["posts"][number];
}) {
  const body = (
    <span
      className="relative block aspect-square overflow-hidden rounded-md"
      style={{ background: "var(--ws-surface-2)" }}
    >
      {post.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN URL, next/image can't optimize it
        <img
          src={post.imageUrl}
          alt={post.caption?.slice(0, 80) ?? "Instagram gönderisi"}
          referrerPolicy="no-referrer"
          loading="lazy"
          className="size-full object-cover"
        />
      ) : null}
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-4 pb-1 text-[10px] font-medium text-white">
        <span className="inline-flex items-center gap-0.5">
          <Heart className="size-2.5" />
          {formatCount(post.likes)}
        </span>
        <span className="inline-flex items-center gap-0.5">
          <MessageCircle className="size-2.5" />
          {formatCount(post.comments)}
        </span>
      </span>
    </span>
  );
  return post.permalink ? (
    <a href={post.permalink} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  ) : (
    body
  );
}
