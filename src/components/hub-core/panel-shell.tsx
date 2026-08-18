import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import { buildHubHref, type EntityRef, type PanelKey } from "./hub-core-params";
import { PANEL_LABEL } from "./lineage-map";
import { HubBreadcrumb } from "./hub-breadcrumb";
import { KurulumPanel } from "./panels/kurulum-panel";
import { KutuphanePanel } from "./panels/kutuphane-panel";
import { MarkaBeyniPanel } from "./panels/marka-beyni-panel";
import { SinyallerPanel } from "./panels/sinyaller-panel";
import { IcgoruFirsatPanel } from "./panels/icgoru-firsat-panel";
import { HedeflerPanel } from "./panels/hedefler-panel";
import { FikirlerPanel } from "./panels/fikirler-panel";
import { IslerPanel } from "./panels/isler-panel";
import { DepartmanlarPanel } from "./panels/departmanlar-panel";
import { OnaylarPanel } from "./panels/onaylar-panel";
import { InsanEylemPanel } from "./panels/insan-eylem-panel";
import { AyarlarPanel } from "./panels/ayarlar-panel";
import type { PanelProps } from "./panels/panel-props";

const PANEL_COMPONENT: Record<
  PanelKey,
  (props: PanelProps) => Promise<React.ReactNode>
> = {
  kurulum: KurulumPanel,
  "marka-beyni": MarkaBeyniPanel,
  sinyaller: SinyallerPanel,
  "icgoru-firsat": IcgoruFirsatPanel,
  hedefler: HedeflerPanel,
  fikirler: FikirlerPanel,
  isler: IslerPanel,
  departmanlar: DepartmanlarPanel,
  onaylar: OnaylarPanel,
  "insan-eylem": InsanEylemPanel,
  ayarlar: AyarlarPanel,
  kutuphane: KutuphanePanel,
};

// `?panel=&sub=&entity=` sözleşmesine göre dispatch eden görünüm — artık
// modal değil, proje köküyle (sohbet) yer değiştiren tam sayfa bir içerik
// (ChatGPT'nin ayarlar/araçlar ekranlarına geçişi gibi: üstte geri linki,
// altında sade, tek sütun bir içerik alanı). Kapanınca proje köküne
// (sohbet ekranına) döner.
export async function PanelShell({
  projectId,
  panel,
  sub,
  entity,
}: {
  projectId: string;
  panel: PanelKey | null;
  sub: string | null;
  entity: EntityRef | null;
}) {
  if (!panel) return null;

  const closeHref = buildHubHref(projectId, {
    panel: null,
    sub: null,
    entity: null,
  });
  const Panel = PANEL_COMPONENT[panel];
  // fikirler ve isler panellerinin liste (kanban) görünümü sayfa
  // kaydırmasını değil, kendi sütun/kart taşmasını kullanır — bir entity
  // detayı açıldığında (entity=idea:ID, entity=task:ID vb.) ise normal
  // uzun-kaydırmalı bir görünüme dönülür, ondan ayırmak gerekiyor. isler'in
  // 4 alt-sekmesinin (planlar/gorevler/devirler/olcumler) hepsi artık aynı
  // kanban sistemi (bkz. isler-panel.tsx *Board fonksiyonları).
  const isBoard = (panel === "fikirler" || panel === "isler") && !entity;

  return (
    <div
      className={cn(
        "h-[calc(100vh-4rem)]",
        isBoard ? "flex flex-col overflow-hidden" : "overflow-y-auto",
      )}
    >
      <div
        className={cn(
          "w-full pt-8",
          isBoard
            ? "flex min-h-0 flex-1 flex-col px-4 pb-6 sm:px-6"
            : "mx-auto max-w-5xl px-6 pb-16",
        )}
      >
        <Link
          href={closeHref}
          scroll={false}
          className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Sohbete dön
        </Link>
        <h1 className="mt-4 shrink-0 font-heading text-2xl font-semibold tracking-tight">
          {PANEL_LABEL[panel]}
        </h1>
        <div className="shrink-0">
          <HubBreadcrumb projectId={projectId} panel={panel} />
        </div>
        <div className={cn("mt-6", isBoard && "flex min-h-0 flex-1 flex-col")}>
          <Panel projectId={projectId} entity={entity} sub={sub} />
        </div>
      </div>
    </div>
  );
}
