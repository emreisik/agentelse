import Link from "next/link";
import { notFound } from "next/navigation";
import {
  BarChart3,
  Check,
  Image as ImageIcon,
  Plug,
  RefreshCw,
  Send,
  type LucideIcon,
} from "lucide-react";
import type {
  BrowserProfile,
  BrowserProfilePurpose,
  IntegrationCredential,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import { isIntegrationConfigured } from "@/lib/env";
import { BROWSER_PROFILE_STATUS } from "@/lib/labels";
import { PURPOSE_ICONS } from "@/features/dashboard/purpose-icons";
import { BROWSER_PROFILE_TRANSITIONS } from "@/server/state-machine/transitions";
import type { GoogleCredentialMetadata } from "@/server/integrations/google-client";
import type { MetaCredentialMetadata } from "@/server/integrations/meta-client";
import {
  addIntegrationAction,
  disableIntegrationAction,
  markIntegrationConnectedAction,
} from "@/server/actions/integration-actions";
import {
  disconnectTelegramAction,
  sendTelegramTestMessageAction,
  updateTelegramApproversAction,
} from "@/server/actions/telegram-actions";
import {
  disconnectGoogleAction,
  refreshGoogleListsAction,
  selectGa4PropertyAction,
  selectSearchConsoleSiteAction,
  testGoogleConnectionAction,
} from "@/server/actions/google-actions";
import {
  disconnectMetaAction,
  selectMetaAdAccountAction,
  selectMetaPageAction,
  testMetaConnectionAction,
} from "@/server/actions/meta-actions";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { EntityDialog } from "@/components/shared/entity-dialog";
import { ModeSwitcher } from "@/components/shared/mode-switcher";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { TelegramConnectForm } from "@/components/integrations/telegram-connect-form";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";

const CATEGORIES = {
  sosyal: {
    title: "Sosyal Medya",
    purposes: [
      "INSTAGRAM",
      "TIKTOK",
      "LINKEDIN",
      "X",
    ] as BrowserProfilePurpose[],
  },
  reklam: {
    title: "Reklam",
    purposes: ["META_ADS", "GOOGLE_ADS"] as BrowserProfilePurpose[],
  },
  analitik: {
    title: "Analitik & Diğer",
    purposes: [
      "GA4",
      "SEARCH_CONSOLE",
      "CRM",
      "EMAIL",
    ] as BrowserProfilePurpose[],
  },
};

const FILTERS = [
  { key: "tumu", label: "Tümü" },
  { key: "mesajlasma", label: "Mesajlaşma" },
  { key: "sosyal", label: "Sosyal Medya" },
  { key: "reklam", label: "Reklam" },
  { key: "analitik", label: "Analitik & Diğer" },
  { key: "kurulu", label: "Kurulu" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export default async function EntegrasyonlarPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  const { userId } = await requireUser();
  try {
    await requireProjectAccess(userId, projectId);
  } catch {
    notFound();
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  if (!project) notFound();

  const [allProfiles, telegramCredential, googleCredential, metaCredential] =
    await Promise.all([
      prisma.browserProfile.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.integrationCredential.findFirst({
        where: { projectId, provider: "telegram" },
      }),
      prisma.integrationCredential.findFirst({
        where: { projectId, provider: "google" },
      }),
      prisma.integrationCredential.findFirst({
        where: { projectId, provider: "meta" },
      }),
    ]);
  const profilesByPurpose = new Map<BrowserProfilePurpose, BrowserProfile[]>();
  for (const profile of allProfiles) {
    const list = profilesByPurpose.get(profile.purpose) ?? [];
    list.push(profile);
    profilesByPurpose.set(profile.purpose, list);
  }
  const telegramConnected = telegramCredential?.status === "ACTIVE";

  const filter: FilterKey =
    typeof sp.kategori === "string" &&
    FILTERS.some((f) => f.key === sp.kategori)
      ? (sp.kategori as FilterKey)
      : "tumu";
  const base = `/projects/${projectId}/entegrasyonlar`;
  const closeHref = filter === "tumu" ? base : `${base}?kategori=${filter}`;

  const showMesajlasma =
    filter === "tumu" ||
    filter === "mesajlasma" ||
    (filter === "kurulu" && telegramConnected);

  const sections =
    filter === "tumu"
      ? Object.values(CATEGORIES)
      : filter === "kurulu"
        ? [
            {
              title: "Kurulu Entegrasyonlar",
              purposes: Object.values(CATEGORIES)
                .flatMap((c) => c.purposes)
                .filter((p) => (profilesByPurpose.get(p)?.length ?? 0) > 0),
            },
          ]
        : filter === "mesajlasma"
          ? []
          : [CATEGORIES[filter]];

  const openTelegram = sp.entegrasyon === "telegram";
  const openGoogle = sp.entegrasyon === "google";
  const openMeta = sp.entegrasyon === "meta";
  const googleError =
    typeof sp.googleError === "string" ? sp.googleError : null;
  const metaError = typeof sp.metaError === "string" ? sp.metaError : null;
  const openPurpose =
    typeof sp.entegrasyon === "string" &&
    Object.values(CATEGORIES).some((c) =>
      c.purposes.includes(sp.entegrasyon as BrowserProfilePurpose),
    )
      ? (sp.entegrasyon as BrowserProfilePurpose)
      : null;

  return (
    <AppShell projectId={projectId}>
      <div className="space-y-6 p-6 pb-16">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Entegrasyonlar
          </h1>
          <p className="text-sm text-muted-foreground">
            {project.name} — kanal ve reklam hesabı bağlantı durumu
          </p>
          <p className="mt-2 max-w-2xl text-xs text-muted-foreground/80">
            Aşağıdaki kanal/reklam bağlantılarının çoğu tıkla-bağlan (OAuth)
            ekranı değil: bağlantılar bir operatör tarafından OpenClaw üzerinden
            manuel olarak kurulur, burada sadece durumu görür ve işaretlersiniz.{" "}
            <strong>Google</strong> ve <strong>Meta</strong> bunun istisnası —
            gerçek OAuth ile kendi hesabınızı bağlayıp Instagram paylaşımı ve
            reklam kampanyası yönetimi için izin verebilirsiniz.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === "tumu" ? base : `${base}?kategori=${f.key}`}
              className={cn(
                "flex h-8 items-center gap-1 rounded-full px-3.5 text-xs font-medium transition-colors",
                filter === f.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent",
              )}
            >
              {f.key === "kurulu" && filter === "kurulu" ? (
                <Check className="size-3" />
              ) : null}
              {f.label}
            </Link>
          ))}
        </div>

        {showMesajlasma ? (
          <IntegrationSection title="Mesajlaşma">
            <TelegramTile
              base={base}
              kategori={filter === "tumu" ? undefined : filter}
              credential={telegramCredential}
            />
          </IntegrationSection>
        ) : null}

        <IntegrationSection title="Raporlama Bağlantısı">
          <GoogleTile
            base={base}
            kategori={filter === "tumu" ? undefined : filter}
            credential={googleCredential}
          />
        </IntegrationSection>

        <IntegrationSection title="Meta Bağlantısı (Instagram + Reklam)">
          <MetaTile
            base={base}
            kategori={filter === "tumu" ? undefined : filter}
            credential={metaCredential}
          />
        </IntegrationSection>

        {sections.map((section) =>
          section.purposes.length === 0 ? null : (
            <IntegrationSection key={section.title} title={section.title}>
              {section.purposes.map((purpose) => (
                <IntegrationTile
                  key={purpose}
                  base={base}
                  kategori={filter === "tumu" ? undefined : filter}
                  purpose={purpose}
                  profiles={profilesByPurpose.get(purpose) ?? []}
                />
              ))}
            </IntegrationSection>
          ),
        )}

        {openPurpose ? (
          <IntegrationDialog
            projectId={projectId}
            purpose={openPurpose}
            profiles={profilesByPurpose.get(openPurpose) ?? []}
            closeHref={closeHref}
          />
        ) : null}

        {openTelegram ? (
          <TelegramDialog
            projectId={projectId}
            credential={telegramCredential}
            closeHref={closeHref}
          />
        ) : null}

        {openGoogle ? (
          <GoogleDialog
            projectId={projectId}
            credential={googleCredential}
            closeHref={closeHref}
            googleError={googleError}
          />
        ) : null}

        {openMeta ? (
          <MetaDialog
            projectId={projectId}
            credential={metaCredential}
            closeHref={closeHref}
            metaError={metaError}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------

type ConnectionTone = "positive" | "waiting" | "neutral";

function summarize(profiles: BrowserProfile[]): {
  label: string;
  subtitle: string;
  tone: ConnectionTone;
} {
  if (profiles.length === 0) {
    return {
      label: "Bağlı değil",
      subtitle: "Henüz eklenmedi",
      tone: "neutral",
    };
  }
  const connected = profiles.filter((p) => p.status === "READY").length;
  if (connected > 0) {
    return {
      label: `${connected} bağlı`,
      subtitle: `${profiles.length} hesap kayıtlı`,
      tone: "positive",
    };
  }
  return {
    label: "Bağlı değil",
    subtitle: "Kurulu, henüz bağlı değil",
    tone: "waiting",
  };
}

// Entegrasyonlar sayfasının ortak kartı — nötr (renksiz) ikon rozeti,
// üstte durum rozeti, altında başlık + kısa açıklama. Markaya özgü renkli
// kutucuklar yerine tek, sade bir görsel dil; IntegrationSection'daki grid
// sayesinde kartlar yan yana dizilir.
function IntegrationRow({
  href,
  icon: Icon,
  title,
  subtitle,
  badge,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  badge: { label: string; tone: ConnectionTone };
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-3 rounded-xl border border-border p-3.5 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
        <StatusBadge meta={{ label: badge.label, tone: badge.tone }} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </Link>
  );
}

function IntegrationSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {children}
      </div>
    </section>
  );
}

function IntegrationTile({
  base,
  kategori,
  purpose,
  profiles,
}: {
  base: string;
  kategori: string | undefined;
  purpose: BrowserProfilePurpose;
  profiles: BrowserProfile[];
}) {
  const meta = PURPOSE_ICONS[purpose];
  const summary = summarize(profiles);
  const params = new URLSearchParams({ entegrasyon: purpose });
  if (kategori) params.set("kategori", kategori);

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={meta.icon}
      title={meta.label}
      subtitle={summary.subtitle}
      badge={{ label: summary.label, tone: summary.tone }}
    />
  );
}

// ---------------------------------------------------------------------------

function IntegrationDialog({
  projectId,
  purpose,
  profiles,
  closeHref,
}: {
  projectId: string;
  purpose: BrowserProfilePurpose;
  profiles: BrowserProfile[];
  closeHref: string;
}) {
  const meta = PURPOSE_ICONS[purpose];
  const Icon = meta.icon;

  return (
    <EntityDialog
      closeHref={closeHref}
      title={meta.label}
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{meta.label}</p>
            <p className="text-xs text-muted-foreground">
              Bağlantı ekleyin, durumu yönetin
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      <div className="space-y-2">
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Bağlı hesaplar
        </p>
        {profiles.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="Henüz eklenmedi"
            hint="Aşağıdan bir isim girip yeni bir bağlantı kaydı açabilirsiniz."
            className="py-8"
          />
        ) : (
          <div className="space-y-1.5">
            {profiles.map((profile) => (
              <IntegrationProfileRow
                key={profile.id}
                projectId={projectId}
                profile={profile}
              />
            ))}
          </div>
        )}
      </div>

      <ActionForm
        action={addIntegrationAction}
        successMessage={`${meta.label} eklendi`}
        className="flex items-center gap-1.5 border-t border-foreground/10 pt-4"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="purpose" value={purpose} />
        <Input
          name="name"
          placeholder={`${meta.label} hesap adı`}
          className="h-8 flex-1 text-xs"
        />
        <SubmitButton size="xs">+ Yeni Bağlantı Ekle</SubmitButton>
      </ActionForm>
    </EntityDialog>
  );
}

function IntegrationProfileRow({
  projectId,
  profile,
}: {
  projectId: string;
  profile: BrowserProfile;
}) {
  const transitions = BROWSER_PROFILE_TRANSITIONS[profile.status];
  const canDisable =
    profile.status !== "DISABLED" && transitions.includes("DISABLED");
  const canMarkConnected =
    profile.status !== "READY" && transitions.includes("READY");
  const markConnectedLabel =
    profile.status === "DISABLED"
      ? "Yeniden Etkinleştir"
      : "Bağlı Olarak İşaretle";

  return (
    <div className="space-y-2 rounded-lg p-3 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">{profile.name}</p>
        <StatusBadge meta={BROWSER_PROFILE_STATUS[profile.status]} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {profile.lastUsedAt
          ? `Son kullanım: ${timeAgo(profile.lastUsedAt)}`
          : `Bağlantı tarihi: ${timeAgo(profile.createdAt)}`}
        {profile.lastHealthCheckAt
          ? ` · Son kontrol: ${timeAgo(profile.lastHealthCheckAt)}`
          : ""}
      </p>
      {canDisable || canMarkConnected ? (
        <div className="flex items-center justify-end gap-1.5">
          {canDisable ? (
            <ActionForm
              action={disableIntegrationAction}
              successMessage="Devre dışı bırakıldı"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="profileId" value={profile.id} />
              <SubmitButton variant="outline" size="xs">
                Devre Dışı Bırak
              </SubmitButton>
            </ActionForm>
          ) : null}
          {canMarkConnected ? (
            <ActionForm
              action={markIntegrationConnectedAction}
              successMessage="Bağlı olarak işaretlendi"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="profileId" value={profile.id} />
              <SubmitButton size="xs">{markConnectedLabel}</SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telegram — BrowserProfile değil, IntegrationCredential (Bot API token'ı)
// tabanlı, ayrı bir bağlantı modeli. Kurulum sırasında gerçekten Telegram'a
// karşı doğrulanıyor (bkz. connectTelegramAction) — mock/demo satır yok.

function TelegramTile({
  base,
  kategori,
  credential,
}: {
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const params = new URLSearchParams({ entegrasyon: "telegram" });
  if (kategori) params.set("kategori", kategori);

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={Send}
      title="Telegram"
      subtitle={
        connected
          ? (credential.accountLabel ?? "Bağlı")
          : credential
            ? "Bağlantı kesildi"
            : "Onay ve bildirimler için bağlayın"
      }
      badge={
        connected
          ? { label: "Bağlı", tone: "positive" }
          : credential
            ? { label: "Bağlantı kesildi", tone: "waiting" }
            : { label: "Bağlı değil", tone: "neutral" }
      }
    />
  );
}

function TelegramDialog({
  projectId,
  credential,
  closeHref,
}: {
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
}) {
  const metadata = (credential?.metadata ?? {}) as {
    chatId?: string;
    chatTitle?: string;
    allowedApproverIds?: string[];
  };
  const connected = credential?.status === "ACTIVE";

  return (
    <EntityDialog
      closeHref={closeHref}
      title="Telegram"
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <Send className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Telegram</p>
            <p className="text-xs text-muted-foreground">
              Kanala/gruba yayın gönderin
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {credential ? (
        <div className="space-y-2 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "Telegram botu"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Bağlı", tone: "positive" }
                  : { label: "Bağlı değil", tone: "neutral" }
              }
            />
          </div>
          {metadata.chatTitle ? (
            <p className="text-[11px] text-muted-foreground">
              Hedef: {metadata.chatTitle}
            </p>
          ) : null}
          {connected ? (
            <ActionForm
              action={updateTelegramApproversAction}
              successMessage="Onay yetkilileri güncellendi"
              className="space-y-1"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <label className="text-[11px] font-medium text-muted-foreground">
                Onay yetkisi olan Telegram kullanıcı ID&apos;leri
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  name="allowedApproverIds"
                  placeholder="123456789, 987654321"
                  defaultValue={metadata.allowedApproverIds?.join(", ") ?? ""}
                  className="h-7 text-xs"
                />
                <SubmitButton size="xs" variant="outline">
                  Kaydet
                </SubmitButton>
              </div>
              <p className="text-[10px] text-muted-foreground/70">
                Boş bırakılırsa onay mesajları sadece bilgilendirme amaçlı
                gönderilir, buton eklenmez. Kendi ID&apos;nizi @userinfobot ile
                bulabilirsiniz.
              </p>
            </ActionForm>
          ) : null}
          {connected ? (
            <div className="flex items-center justify-end gap-1.5">
              <ActionForm
                action={disconnectTelegramAction}
                successMessage="Bağlantı kesildi"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton variant="outline" size="xs">
                  Bağlantıyı Kes
                </SubmitButton>
              </ActionForm>
              <ActionForm
                action={sendTelegramTestMessageAction}
                successMessage="Test mesajı gönderildi — Telegram'ı kontrol edin"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton size="xs">Test Mesajı Gönder</SubmitButton>
              </ActionForm>
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState
          icon={Send}
          title="Henüz bağlı değil"
          hint="Aşağıya bot token'ını ve hedef sohbeti girerek bağlayın."
          className="py-8"
        />
      )}

      <div className="border-t border-foreground/10 pt-4">
        <TelegramConnectForm
          projectId={projectId}
          hasExistingConnection={credential !== null}
        />
      </div>
    </EntityDialog>
  );
}

// ---------------------------------------------------------------------------
// Google — IntegrationCredential (provider: "google") tabanlı, gerçek OAuth
// bağlantısı (GA4 + Search Console tek grant). Yukarıdaki BrowserProfile
// tabanlı "GA4"/"SEARCH_CONSOLE" purpose'larından tamamen ayrı bir mekanizma
// — onlar OpenClaw'ın tarayıcı profilleri, bu gerçek, salt-okunur API erişimi.

const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  denied: "Google izni reddedildi.",
  not_configured: "Bu entegrasyon henüz yapılandırılmadı.",
  no_refresh_token: "Google yenileme token'ı döndürmedi, tekrar deneyin.",
  exchange_failed: "Google ile bağlantı kurulamadı, tekrar deneyin.",
  state_invalid:
    "Bağlantı isteğinin süresi doldu veya geçersiz, tekrar deneyin.",
  unauthorized: "Oturumunuz sona ermiş, tekrar giriş yapıp deneyin.",
};

// Search Console `siteUrl` ham haliyle teknik görünüyor (sc-domain:example.com
// ya da https://example.com/) — seçim listesinde temiz bir domain gösterip
// mülk tipini (Domain/HTTPS/HTTP) hint olarak veriyoruz; aynı domain'in hem
// http hem https ayrı doğrulanmış olabileceği için bu ayrım gerçekten
// ayırt edici, sadece kozmetik değil.
function formatSearchConsoleSite(siteUrl: string): {
  label: string;
  hint?: string;
} {
  if (siteUrl.startsWith("sc-domain:")) {
    return { label: siteUrl.slice("sc-domain:".length), hint: "Domain" };
  }
  try {
    const url = new URL(siteUrl);
    const path = url.pathname === "/" ? "" : url.pathname;
    return {
      label: `${url.hostname}${path}`,
      hint: url.protocol === "https:" ? "HTTPS" : "HTTP",
    };
  } catch {
    return { label: siteUrl };
  }
}

function GoogleTile({
  base,
  kategori,
  credential,
}: {
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const params = new URLSearchParams({ entegrasyon: "google" });
  if (kategori) params.set("kategori", kategori);

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={BarChart3}
      title="Google Analytics & Search Console"
      subtitle={
        connected
          ? (credential.accountLabel ?? "Bağlı")
          : expired
            ? "Yeniden bağlanmalı"
            : "GA4 ve Search Console verilerine erişim"
      }
      badge={
        connected
          ? { label: "Bağlı", tone: "positive" }
          : expired
            ? { label: "Yeniden bağlanmalı", tone: "waiting" }
            : { label: "Bağlı değil", tone: "neutral" }
      }
    />
  );
}

function GoogleDialog({
  projectId,
  credential,
  closeHref,
  googleError,
}: {
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
  googleError: string | null;
}) {
  const metadata = (credential?.metadata ?? {}) as GoogleCredentialMetadata;
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const configured = isIntegrationConfigured("GOOGLE");

  return (
    <EntityDialog
      closeHref={closeHref}
      title="Google Analytics & Search Console"
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <BarChart3 className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              Google Analytics & Search Console
            </p>
            <p className="text-xs text-muted-foreground">
              GA4 ve Search Console&apos;a salt-okunur erişim
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {googleError ? (
        <p className="rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          {GOOGLE_ERROR_MESSAGES[googleError] ??
            "Bir şeyler ters gitti, tekrar deneyin."}
        </p>
      ) : null}

      {credential && (connected || expired) ? (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "Google hesabı"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Bağlı", tone: "positive" }
                  : { label: "Yeniden bağlanmalı", tone: "waiting" }
              }
            />
          </div>

          {expired ? (
            // Next <Link>'in RSC-fetch tabanlı yumuşak navigasyonu, bu route
            // Google'ın OAuth dialog'una (cross-origin) redirect ettiği için
            // CORS preflight'a takılıyor — düz <a> tam sayfa navigasyon
            // yapıp bunu tamamen atlıyor.
            <a
              href={`/api/integrations/google/start?projectId=${projectId}`}
              className={cn(buttonVariants({ size: "xs" }))}
            >
              Yeniden Bağlan
            </a>
          ) : (
            <>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Property / Site Seçimi
                  </span>
                  <ActionForm
                    action={refreshGoogleListsAction}
                    successMessage="Liste güncellendi"
                  >
                    <input type="hidden" name="projectId" value={projectId} />
                    <SubmitButton
                      variant="ghost"
                      size="icon-xs"
                      title="Google'da yeni eklenen property/site'ları getir"
                    >
                      <RefreshCw className="size-3.5" />
                    </SubmitButton>
                  </ActionForm>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    GA4 Property
                  </span>
                  {metadata.ga4Properties.length > 0 ? (
                    <SearchableSelect
                      value={metadata.selectedGa4PropertyId ?? ""}
                      placeholder="Property seçin…"
                      searchPlaceholder="Property ara…"
                      options={metadata.ga4Properties.map((p) => ({
                        value: p.propertyId,
                        label: p.propertyName,
                        hint: p.accountName || undefined,
                      }))}
                      action={selectGa4PropertyAction}
                      hiddenFields={{ projectId }}
                      fieldName="propertyId"
                      successMessage="GA4 property güncellendi"
                    />
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {metadata.ga4ListError ??
                        "Erişilebilir property bulunamadı"}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Search Console Site
                  </span>
                  {metadata.searchConsoleSites.length > 0 ? (
                    <SearchableSelect
                      value={metadata.selectedSearchConsoleSite ?? ""}
                      placeholder="Site seçin…"
                      searchPlaceholder="Site ara…"
                      options={metadata.searchConsoleSites.map((s) => ({
                        value: s.siteUrl,
                        ...formatSearchConsoleSite(s.siteUrl),
                      }))}
                      action={selectSearchConsoleSiteAction}
                      hiddenFields={{ projectId }}
                      fieldName="siteUrl"
                      successMessage="Search Console site güncellendi"
                    />
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {metadata.gscListError ?? "Erişilebilir site bulunamadı"}
                    </p>
                  )}
                </div>
              </div>

              {metadata.lastTestResult ? (
                <p className="text-[11px] text-muted-foreground">
                  Son test ({timeAgo(metadata.lastTestResult.testedAt)}):{" "}
                  {metadata.lastTestResult.error
                    ? metadata.lastTestResult.error
                    : [
                        metadata.lastTestResult.ga4ActiveUsers !== undefined
                          ? `GA4: ${metadata.lastTestResult.ga4ActiveUsers} kullanıcı (7g)`
                          : null,
                        metadata.lastTestResult.gscClicks !== undefined
                          ? `GSC: ${metadata.lastTestResult.gscClicks} tıklama / ${metadata.lastTestResult.gscImpressions} gösterim (7g)`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-1.5">
                <ActionForm
                  action={disconnectGoogleAction}
                  successMessage="Bağlantı kesildi"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton variant="outline" size="xs">
                    Bağlantıyı Kes
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={testGoogleConnectionAction}
                  successMessage="Test başarılı"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton size="xs">Test Et</SubmitButton>
                </ActionForm>
              </div>
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={BarChart3}
          title="Henüz bağlı değil"
          hint="Google hesabınızla bağlanın, ardından GA4 property ve Search Console site'ınızı seçin."
          className="py-8"
        >
          {/* Düz <a>: bkz. "Yeniden Bağlan" üzerindeki not — <Link>'in
              RSC-fetch navigasyonu cross-origin OAuth redirect'ine CORS
              hatası veriyor. */}
          <a
            href={`/api/integrations/google/start?projectId=${projectId}`}
            className={cn(
              buttonVariants({ size: "xs" }),
              !configured && "pointer-events-none opacity-50",
            )}
            aria-disabled={!configured}
          >
            Google ile Bağlan
          </a>
        </EmptyState>
      )}
    </EntityDialog>
  );
}

// ---------------------------------------------------------------------------
// Meta — IntegrationCredential (provider: "meta") tabanlı, gerçek OAuth
// bağlantısı (Instagram Content Publishing + Marketing API tek grant).
// Yukarıdaki BrowserProfile tabanlı "INSTAGRAM"/"META_ADS" purpose'larından
// tamamen ayrı bir mekanizma — onlar OpenClaw'ın tarayıcı profilleri, bu
// gerçek Graph/Marketing API erişimi.

const META_ERROR_MESSAGES: Record<string, string> = {
  denied: "Meta izni reddedildi.",
  not_configured: "Bu entegrasyon henüz yapılandırılmadı.",
  exchange_failed: "Meta ile bağlantı kurulamadı, tekrar deneyin.",
  state_invalid:
    "Bağlantı isteğinin süresi doldu veya geçersiz, tekrar deneyin.",
  unauthorized: "Oturumunuz sona ermiş, tekrar giriş yapıp deneyin.",
};

function MetaTile({
  base,
  kategori,
  credential,
}: {
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const params = new URLSearchParams({ entegrasyon: "meta" });
  if (kategori) params.set("kategori", kategori);

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={ImageIcon}
      title="Instagram & Meta Ads"
      subtitle={
        connected
          ? (credential.accountLabel ?? "Bağlı")
          : expired
            ? "Yeniden bağlanmalı"
            : "Paylaşım ve reklam kampanyası yönetimi"
      }
      badge={
        connected
          ? { label: "Bağlı", tone: "positive" }
          : expired
            ? { label: "Yeniden bağlanmalı", tone: "waiting" }
            : { label: "Bağlı değil", tone: "neutral" }
      }
    />
  );
}

function MetaDialog({
  projectId,
  credential,
  closeHref,
  metaError,
}: {
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
  metaError: string | null;
}) {
  const metadata = (credential?.metadata ?? {}) as MetaCredentialMetadata;
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const configured = isIntegrationConfigured("META");

  return (
    <EntityDialog
      closeHref={closeHref}
      title="Instagram & Meta Ads"
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <ImageIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Instagram & Meta Ads</p>
            <p className="text-xs text-muted-foreground">
              Instagram paylaşımı ve reklam kampanyası yönetimi için erişim
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {metaError ? (
        <p className="rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          {META_ERROR_MESSAGES[metaError] ??
            "Bir şeyler ters gitti, tekrar deneyin."}
        </p>
      ) : null}

      {credential && (connected || expired) ? (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "Meta hesabı"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Bağlı", tone: "positive" }
                  : { label: "Yeniden bağlanmalı", tone: "waiting" }
              }
            />
          </div>

          {expired ? (
            // Düz <a>: bkz. Google bloğundaki not — <Link>'in RSC-fetch
            // navigasyonu Meta'nın OAuth dialog'una (cross-origin) CORS
            // hatası veriyor.
            <a
              href={`/api/integrations/meta/start?projectId=${projectId}`}
              className={cn(buttonVariants({ size: "xs" }))}
            >
              Yeniden Bağlan
            </a>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Facebook Page (Instagram)
                  </span>
                  {metadata.pages.length > 0 ? (
                    <ModeSwitcher
                      value={metadata.selectedPageId ?? ""}
                      options={metadata.pages.map((p) => ({
                        value: p.pageId,
                        label: p.instagramUsername
                          ? `${p.pageName} (@${p.instagramUsername})`
                          : p.pageName,
                      }))}
                      action={selectMetaPageAction}
                      hiddenFields={{ projectId }}
                      fieldName="pageId"
                      successMessage="Page güncellendi"
                    />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      {metadata.pagesListError ??
                        "Erişilebilir Page bulunamadı"}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Reklam Hesabı
                  </span>
                  {metadata.adAccounts.length > 0 ? (
                    <ModeSwitcher
                      value={metadata.selectedAdAccountId ?? ""}
                      options={metadata.adAccounts.map((a) => ({
                        value: a.adAccountId,
                        label: a.adAccountName,
                      }))}
                      action={selectMetaAdAccountAction}
                      hiddenFields={{ projectId }}
                      fieldName="adAccountId"
                      successMessage="Reklam hesabı güncellendi"
                    />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      {metadata.adAccountsListError ??
                        "Erişilebilir reklam hesabı bulunamadı"}
                    </span>
                  )}
                </div>
              </div>

              {metadata.lastTestResult ? (
                <p className="text-[11px] text-muted-foreground">
                  Son test ({timeAgo(metadata.lastTestResult.testedAt)}):{" "}
                  {metadata.lastTestResult.error
                    ? metadata.lastTestResult.error
                    : [
                        metadata.lastTestResult.igUsername
                          ? `IG: @${metadata.lastTestResult.igUsername}`
                          : null,
                        metadata.lastTestResult.adAccountSpend !== undefined
                          ? `Harcama (7g): ${metadata.lastTestResult.adAccountSpend}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-1.5">
                <ActionForm
                  action={disconnectMetaAction}
                  successMessage="Bağlantı kesildi"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton variant="outline" size="xs">
                    Bağlantıyı Kes
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={testMetaConnectionAction}
                  successMessage="Test başarılı"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton size="xs">Test Et</SubmitButton>
                </ActionForm>
              </div>
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={ImageIcon}
          title="Henüz bağlı değil"
          hint="Meta hesabınızla bağlanın, ardından Page ve reklam hesabınızı seçin."
          className="py-8"
        >
          {/* Düz <a>: bkz. Google bloğundaki not. */}
          <a
            href={`/api/integrations/meta/start?projectId=${projectId}`}
            className={cn(
              buttonVariants({ size: "xs" }),
              !configured && "pointer-events-none opacity-50",
            )}
            aria-disabled={!configured}
          >
            Meta ile Bağlan
          </a>
        </EmptyState>
      )}
    </EntityDialog>
  );
}
