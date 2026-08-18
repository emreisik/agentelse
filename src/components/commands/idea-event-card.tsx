"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DepartmentKey } from "@prisma/client";
import {
  CheckCircle2,
  ChevronRight,
  CircleCheck,
  ClipboardList,
  Compass,
  FileSearch,
  Lightbulb,
  Loader2,
  Radio,
  Send,
  ShieldCheck,
  ShieldX,
  Sparkles,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { DepartmentBadge } from "@/components/shared/department-badge";
import {
  TONE_CLASSES,
  DEPARTMENT_KEY,
  RISK_LEVEL,
  stripCapabilityPrefix,
  type StatusTone,
} from "@/lib/labels";
import { CreativeCard } from "@/components/commands/creative-card";
import { isCreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";

// Kart çerçevesinin ton'a göre yumuşak rengi — TONE_CLASSES'la aynı token
// ailesinden (oklch --success/--primary/--warning/--destructive/--special),
// sadece badge yerine kart zeminine uygulanmış hali. Yeni renk YOK, sadece
// mevcut semantik paletin kart seviyesinde de kullanılması.
const CARD_TONE_CLASSES: Record<StatusTone, string> = {
  positive: "ring-success/20 bg-success/[0.04]",
  active: "ring-primary/20 bg-primary/[0.04]",
  waiting: "ring-warning/20 bg-warning/[0.04]",
  neutral: "ring-foreground/10 bg-card",
  danger: "ring-destructive/20 bg-destructive/[0.04]",
  special: "ring-special/20 bg-special/[0.04]",
};

// Ham departman string'ini (ör. "BRAND_STRATEGY") geçerliyse DepartmentKey'e
// daraltır — kartlarda departmandan söz edilen HER yerde DepartmentBadge
// (departmanlar sayfasındaki AYNI ikon+renk) kullanılsın diye, sade
// metin/renk-siz ikon YOK.
function asDepartmentKey(department?: string): DepartmentKey | undefined {
  return department && department in DEPARTMENT_KEY
    ? (department as DepartmentKey)
    : undefined;
}

// Bir fikrin sohbetindeki HER pipeline olayının ortak render'ı — "altın
// kural": köken sinyalinden kreatif üretimine kadar hepsi aynı kart
// formatında. Üstte ikon + başlık (+ varsa rozet) HER ZAMAN görünür; uzun
// gövdeler (konsey gerekçesi, görev çıktı metni, bulgu/içgörü açıklaması)
// EventDetailToggle ile varsayılan kapalı, tıklayınca açılır.
export function IdeaEventCard({ card }: { card: IdeaEventCardData }) {
  if (isCreativeCardData(card)) return <CreativeCard card={card} />;

  switch (card.kind) {
    case "signal":
      return (
        <EventCard icon={Radio} title={card.title} tone="special">
          {card.summary ? (
            <EventDetailToggle label="Sinyal detayı">
              {card.summary}
            </EventDetailToggle>
          ) : null}
        </EventCard>
      );

    case "finding":
      return (
        <EventCard icon={FileSearch} title={card.title} tone="neutral">
          <EventDetailToggle label="Bulgu detayı">
            {card.statement}
          </EventDetailToggle>
        </EventCard>
      );

    case "insight-opportunity":
      return (
        <EventCard icon={Sparkles} title={card.title} tone="active">
          {card.summary ? (
            <p className="text-sm text-muted-foreground">{card.summary}</p>
          ) : null}
          {card.description ? (
            <EventDetailToggle label="Fırsat detayı">
              {card.description}
            </EventDetailToggle>
          ) : null}
        </EventCard>
      );

    case "idea":
      return (
        <EventCard icon={Lightbulb} title={card.title} tone="active">
          <p className="text-sm text-muted-foreground">{card.description}</p>
        </EventCard>
      );

    case "council": {
      const tone: StatusTone =
        card.verdict === "REJECT"
          ? "danger"
          : card.verdict === "REVISE"
            ? "waiting"
            : "positive";
      return (
        <EventCard
          icon={Compass}
          title="Konsey değerlendirmesi"
          tone={tone}
          badge={{ label: VERDICT_LABEL[card.verdict] ?? card.verdict, tone }}
        >
          <EventDetailToggle label="Konsey gerekçelerini gör">
            <div className="space-y-3">
              {card.notes.map((note, index) => (
                <div key={index}>
                  <p className="text-sm font-medium text-foreground">
                    {note.council} — {note.verdict}
                  </p>
                  {note.rationale ? (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {note.rationale}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </EventDetailToggle>
        </EventCard>
      );
    }

    case "work-plan":
      return (
        <EventCard icon={ClipboardList} title={card.title} tone="active">
          <ul className="space-y-1.5">
            {card.nodes.map((node, index) => {
              const departmentKey = asDepartmentKey(node.department);
              return (
                <li key={index} className="flex items-start gap-1.5 text-sm">
                  {departmentKey ? (
                    <DepartmentBadge department={departmentKey} size="xs" />
                  ) : (
                    <span className="font-medium text-foreground">
                      {node.department}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    : {node.request}
                  </span>
                </li>
              );
            })}
          </ul>
        </EventCard>
      );

    case "task-running":
      return (
        <EventCard
          icon={Loader2}
          iconClassName="animate-spin"
          title={card.title}
          tone="active"
          badge={{ label: "Çalışıyor", tone: "active" }}
          department={asDepartmentKey(card.department)}
        />
      );

    case "task-result": {
      const tone: StatusTone =
        card.status === "COMPLETED"
          ? "positive"
          : card.status === "CANCELLED"
            ? "neutral"
            : "danger";
      const icon =
        card.status === "COMPLETED"
          ? CheckCircle2
          : card.status === "CANCELLED"
            ? XCircle
            : XCircle;
      const badgeLabel =
        card.status === "COMPLETED"
          ? "Tamamlandı"
          : card.status === "CANCELLED"
            ? "İptal Edildi"
            : "Başarısız";
      return (
        <EventCard
          icon={icon}
          title={card.title}
          tone={tone}
          badge={{ label: badgeLabel, tone }}
          department={asDepartmentKey(card.department)}
        >
          {card.resultText ? (
            <EventDetailToggle label="Üretilen içeriği gör">
              {card.resultText}
            </EventDetailToggle>
          ) : null}
        </EventCard>
      );
    }

    case "approval-request":
      return <ApprovalRequestCard card={card} />;

    case "approval-decision": {
      const tone: StatusTone =
        card.decision === "APPROVED" ? "positive" : "danger";
      return (
        <EventCard
          icon={card.decision === "APPROVED" ? ShieldCheck : ShieldX}
          title={card.title}
          tone={tone}
          badge={{
            label: card.decision === "APPROVED" ? "Onaylandı" : "Reddedildi",
            tone,
          }}
        >
          {card.note ? (
            <EventDetailToggle label="Not">{card.note}</EventDetailToggle>
          ) : null}
        </EventCard>
      );
    }

    case "publish-result": {
      const tone: StatusTone =
        card.status === "COMPLETED" ? "positive" : "danger";
      const hasDetails = Boolean(card.permalink || card.errorMessage);
      return (
        <EventCard
          icon={card.status === "COMPLETED" ? Send : XCircle}
          title={card.title}
          tone={tone}
          badge={{
            label:
              card.status === "COMPLETED"
                ? `${card.platform} — Paylaşıldı`
                : `${card.platform} — Başarısız`,
            tone,
          }}
        >
          {hasDetails ? (
            <EventDetailToggle label="Yayın detayı">
              {card.permalink ? (
                <a
                  href={card.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {card.permalink}
                </a>
              ) : null}
              {card.errorMessage ? <p>{card.errorMessage}</p> : null}
            </EventDetailToggle>
          ) : null}
        </EventCard>
      );
    }

    default:
      return null;
  }
}

const VERDICT_LABEL: Record<string, string> = {
  STRONG_APPROVE: "Güçlü Onay",
  APPROVE: "Onay",
  REVISE: "Revizyon",
  REJECT: "Ret",
};

// Bir görev onay beklerken sohbette gösterilen, doğrudan tıklanabilir
// Onayla/Reddet kartı — ayrı bir Onaylar paneline gitmeye gerek kalmadan
// karar burada verilebilir. Karar sonrası sunucu (bkz.
// resolveApprovalDecisionCard) AYNI satırı "approval-decision" kartına
// günceller; router.refresh() o güncel hali getirir. Arada, sunucu yanıtı
// beklenirken kısa süreliğine iyimser bir sonuç durumu gösterilir.
function ApprovalRequestCard({
  card,
}: {
  card: Extract<IdeaEventCardData, { kind: "approval-request" }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED" | null>(
    null,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const departmentKey = asDepartmentKey(card.department);

  const decide = (to: "APPROVED" | "REJECTED") => {
    setError(undefined);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("approvalId", card.approvalId);
        const action =
          to === "APPROVED" ? approveApprovalAction : rejectApprovalAction;
        const result = await action(formData);
        if (result.ok) {
          setDecision(to);
          toast.success(to === "APPROVED" ? "Onaylandı" : "Reddedildi");
          router.refresh();
        } else {
          setError(result.message);
          toast.error(result.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "İşlem başarısız";
        setError(message);
        toast.error(message);
      }
    });
  };

  if (decision) {
    return (
      <EventCard
        icon={decision === "APPROVED" ? ShieldCheck : ShieldX}
        title={decision === "APPROVED" ? "Onaylandı" : "Reddedildi"}
        tone={decision === "APPROVED" ? "positive" : "danger"}
        department={departmentKey}
      />
    );
  }

  return (
    <div
      className={cn(
        "mt-1 w-full max-w-md space-y-3 rounded-2xl bg-card p-4 ring-1",
        CARD_TONE_CLASSES.waiting,
      )}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <CircleCheck className="size-4 shrink-0 text-foreground" />
          <p className="text-sm font-semibold text-foreground">Onay bekliyor</p>
        </div>
        <StatusBadge meta={RISK_LEVEL[card.riskLevel]} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {stripCapabilityPrefix(card.title)}
        </p>
        {departmentKey ? (
          <DepartmentBadge department={departmentKey} size="xs" />
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Yürütmeden önce onayınız gerekiyor. Reddedilirse görev iptal edilir.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={isPending}
          onClick={() => decide("REJECTED")}
        >
          Reddet
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isPending}
          className="rounded-full bg-success text-success-foreground hover:bg-success/90"
          onClick={() => decide("APPROVED")}
        >
          Onayla
        </Button>
      </div>
    </div>
  );
}

function EventCard({
  icon: Icon,
  iconClassName,
  title,
  tone = "neutral",
  badge,
  department,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  title: string;
  tone?: StatusTone;
  badge?: { label: string; tone: StatusTone };
  department?: DepartmentKey;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-1 w-full max-w-md space-y-2 rounded-2xl bg-card p-3.5 ring-1",
        CARD_TONE_CLASSES[tone],
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            TONE_CLASSES[tone],
          )}
        >
          <Icon className={cn("size-3.5", iconClassName)} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {stripCapabilityPrefix(title)}
          </p>
          {department ? (
            <DepartmentBadge
              department={department}
              size="xs"
              className="mt-0.5"
            />
          ) : null}
        </div>
        {badge ? (
          <StatusBadge meta={{ label: badge.label, tone: badge.tone }} />
        ) : null}
      </div>
      {children ? <div className="pl-9.5">{children}</div> : null}
    </div>
  );
}

// Uzun gövdeler için: varsayılan kapalı, tıklayınca açılır (reasoning.tsx'in
// ReasoningTrigger/ReasoningContent paterni örnek alındı — aynı chevron-
// rotate + collapsible-up/down animasyon sınıfları).
function EventDetailToggle({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group/detail">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors select-none hover:text-foreground">
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
            "group-open/detail:rotate-90",
          )}
        />
        {label}
      </summary>
      <div className="mt-1.5 border-l-2 border-border py-1 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
