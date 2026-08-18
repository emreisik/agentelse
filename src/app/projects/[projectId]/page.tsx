import { notFound } from "next/navigation";
import type { DepartmentKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { DEPARTMENT_KEY } from "@/lib/labels";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import {
  parseHubParams,
  type EntityRef,
} from "@/components/hub-core/hub-core-params";
import { PanelShell } from "@/components/hub-core/panel-shell";
import { ProjectFlowView } from "@/components/hub-core/project-flow-view";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import {
  ProjectChat,
  type ChatAttachment,
  type ChatTurn,
} from "@/components/commands/project-chat";
import { LiveRefresh } from "@/components/shared/live-refresh";
import { ownerOfCapability } from "@/server/agency/departments/department-registry";
import {
  isIdeaEventCardData,
  type IdeaEventCardData,
} from "@/types/idea-event-card";

// Command.parsedIntent, SYSTEM kaynaklı satırlarda { card: IdeaEventCardData }
// olarak yazılır (bkz. IdeaChatRepository) — WEB satırlarında ise komut
// ayrıştırıcının çıktısını taşır, bu yüzden şekli doğrulanmadan kullanılamaz.
// pendingApprovalByCreativeId: bir "creative-ready" kartı IN_REVIEW olduğu
// halde approvalId taşımıyorsa (execution-service.ts'e approvalId eklenmeden
// ÖNCE üretilmiş eski kayıtlar) burada geriye dönük tamamlanır — böylece
// halihazırda bekleyen onaylar da sohbette Onayla/Reddet gösterir, ayrı bir
// backfill script'i gerekmez.
function cardFromParsedIntent(
  parsedIntent: unknown,
  pendingApprovalByCreativeId?: Map<string, string>,
) {
  if (!parsedIntent || typeof parsedIntent !== "object") return undefined;
  const card = (parsedIntent as { card?: unknown }).card;
  if (!isIdeaEventCardData(card)) return undefined;
  if (
    pendingApprovalByCreativeId &&
    card.kind === "creative-ready" &&
    card.status === "IN_REVIEW" &&
    !card.approvalId
  ) {
    const approvalId = pendingApprovalByCreativeId.get(card.creativeId);
    if (approvalId) return { ...card, approvalId };
  }
  return card;
}

// TEK bir departmana bağlı olay mesajlarında (görev/kreatif tamamlanması —
// bkz. IdeaChatRepository.postSystemMessage) parsedIntent.departmentKey
// doluysa sohbette bir renk şeridi olarak gösterilir (bkz. project-chat.tsx,
// assistant-ui/thread.tsx). WEB kaynaklı satırlarda departmentKey hiç
// yazılmaz (parsedIntent orada ParsedIntent şeklindedir — bkz.
// command-service.ts attachParsedIntent) — bu durumda görevin capability'sinden
// (department-registry.ts'teki sabit sahiplik haritası) departman türetilir,
// böylece "Görev oluşturuldu" notu da hangi departmana gittiğini gösterebilir.
function departmentKeyFromParsedIntent(
  parsedIntent: unknown,
): DepartmentKey | undefined {
  if (!parsedIntent || typeof parsedIntent !== "object") return undefined;
  const key = (parsedIntent as { departmentKey?: unknown }).departmentKey;
  if (typeof key === "string" && key in DEPARTMENT_KEY) {
    return key as DepartmentKey;
  }
  const intent = parsedIntent as { kind?: unknown; capability?: unknown };
  if (intent.kind === "CAPABILITY" && typeof intent.capability === "string") {
    return ownerOfCapability(intent.capability as never);
  }
  return undefined;
}

// Bir entity linkinin (sidebar'daki "Sohbetler" listesi, ya da panellerdeki
// çapraz kartlar) hangi fikrin sohbet iş parçacığına ait olduğunu bulur.
// idea → kendisi; workPlan/task → köklerindeki fikir (plain-field ilişki,
// bkz. WorkPlan.ideaId / Task.workPlanId). Bulunamazsa null: mimari
// "her şey tek sohbette" öncesinden kalma fikirsiz kayıtlar için salt
// okunur ProjectFlowView'a düşülür.
async function resolveIdeaId(entity: EntityRef): Promise<string | null> {
  if (entity.kind === "idea") return entity.id;
  if (entity.kind === "workPlan") {
    return IdeaChatRepository.resolveIdeaIdForWorkPlan(entity.id);
  }
  if (entity.kind === "task") {
    return IdeaChatRepository.resolveIdeaIdForTask(entity.id);
  }
  return null;
}

// Proje-içi deneyimin kökü — artık doğrudan proje sohbeti (ChatGPT'nin ana
// ekranı gibi: sol sidebar projeleri/sohbetleri listeler, bir projeye
// tıklamak onun sohbetini açar). Departmanlar/İşler/Sinyaller vb. modüllere
// TopBar'daki Araçlar menüsünden ulaşılır; bir panel seçiliyken
// (`?panel=&sub=&entity=`, bkz. hub-core-params.ts) o panel sohbetin
// YERİNE tam sayfa içerik olarak render edilir — modal değil.
export default async function ProjectChatPage({
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

  const { panel, sub, entity } = parseHubParams(sp);

  if (panel) {
    return (
      <AppShell projectId={projectId}>
        <PanelShell
          projectId={projectId}
          panel={panel}
          sub={sub}
          entity={entity}
        />
      </AppShell>
    );
  }

  // `panel` yokken bir `entity` seçiliyse (sidebar'daki "Sohbetler"
  // listesinden ya da panellerdeki çapraz kartlardan gelen bir tıklama) —
  // bu artık o fikrin GERÇEK, aktif sohbet iş parçacığı: konsey/iş planı/
  // görev/kreatif üretimi pipeline'ının yazdığı sistem mesajlarıyla
  // birlikte, kullanıcı buradan yeni mesaj da yazabilir (bkz. Command.ideaId).
  // Fikre kök olamayan eski kayıtlar için salt okunur ProjectFlowView'a
  // düşülür.
  if (entity) {
    const ideaId = await resolveIdeaId(entity);
    if (ideaId) {
      const [idea, ideaCommands] = await Promise.all([
        prisma.idea.findFirst({
          where: { id: ideaId, projectId },
          select: { title: true },
        }),
        prisma.command.findMany({
          where: { ideaId, source: { in: ["WEB", "SYSTEM"] } },
          orderBy: { createdAt: "desc" },
          take: 200,
          select: {
            id: true,
            source: true,
            rawText: true,
            replyText: true,
            replyStatus: true,
            attachments: true,
            parsedIntent: true,
            createdAt: true,
          },
        }),
      ]);

      if (!idea) notFound();

      // Geriye dönük tamamlama: approvalId taşımayan IN_REVIEW kreatif
      // kartları için bekleyen onayı bul (bkz. cardFromParsedIntent yorumu).
      const creativeIdsNeedingApproval = Array.from(
        new Set(
          ideaCommands
            .map((command) => cardFromParsedIntent(command.parsedIntent))
            .filter(
              (
                card,
              ): card is Extract<
                IdeaEventCardData,
                { kind: "creative-ready" }
              > => {
                if (!card) return false;
                return (
                  card.kind === "creative-ready" &&
                  card.status === "IN_REVIEW" &&
                  !card.approvalId
                );
              },
            )
            .map((card) => card.creativeId),
        ),
      );
      const pendingApprovalByCreativeId = creativeIdsNeedingApproval.length
        ? new Map(
            (
              await prisma.approval.findMany({
                where: {
                  entityType: "Creative",
                  entityId: { in: creativeIdsNeedingApproval },
                  status: "PENDING",
                },
                select: { id: true, entityId: true },
              })
            ).map((approval) => [approval.entityId, approval.id]),
          )
        : undefined;

      return (
        <AppShell projectId={projectId}>
          {/* key={ideaId}: bir fikirden diğerine geçişte assistant-ui'nin
              ThreadPrimitive.Viewport'u YENİDEN mount olsun diye — bu proje
              sohbet arası geçişi Next.js route/searchParam değişimiyle
              yapıyor (assistant-ui'nin kendi "threadListItem.switchedTo"
              olayı hiç tetiklenmiyor), key olmadan React aynı Viewport
              örneğini koruyup eski scroll konumunda bırakıyordu. Yeniden
              mount, kütüphanenin scrollToBottomOnInitialize davranışını
              (bkz. useThreadViewportAutoScroll) her seferinde tazeler —
              sohbet her zaman en alttan/en güncel mesajdan açılır. */}
          <div key={ideaId} className="relative h-[calc(100vh-4rem)]">
            <LiveRefresh
              intervalMs={7000}
              className="absolute top-3 right-4 z-10"
            />
            <ProjectChat
              projectId={projectId}
              projectName={idea.title}
              ideaId={ideaId}
              turns={ideaCommands.reverse().map((command): ChatTurn => ({
                commandId: command.id,
                source: command.source as "WEB" | "SYSTEM",
                text: command.rawText,
                reply: command.replyText,
                replyStatus: command.replyStatus,
                attachments: Array.isArray(command.attachments)
                  ? (command.attachments as ChatAttachment[])
                  : [],
                card: cardFromParsedIntent(
                  command.parsedIntent,
                  pendingApprovalByCreativeId,
                ),
                departmentKey: departmentKeyFromParsedIntent(
                  command.parsedIntent,
                ),
                createdAt: command.createdAt.toISOString(),
              }))}
            />
          </div>
        </AppShell>
      );
    }

    return (
      <AppShell projectId={projectId}>
        <ProjectFlowView projectId={projectId} entity={entity} />
      </AppShell>
    );
  }

  const [project, chatCommands] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    prisma.command.findMany({
      where: { projectId, source: "WEB" },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        rawText: true,
        replyText: true,
        replyStatus: true,
        attachments: true,
        parsedIntent: true,
        createdAt: true,
      },
    }),
  ]);

  if (!project) notFound();

  return (
    <AppShell projectId={projectId}>
      {/* key: bkz. yukarıdaki idea-özel sohbet dalındaki aynı açıklama —
          fikir sohbetinden proje-geneli sohbete (ya da tam tersi) geçişte de
          Viewport'un yeniden mount olup en alttan başlaması için. */}
      <div key="project-general" className="relative h-[calc(100vh-4rem)]">
        <LiveRefresh
          intervalMs={7000}
          className="absolute top-3 right-4 z-10"
        />
        <ProjectChat
          projectId={projectId}
          projectName={project.name}
          turns={chatCommands.reverse().map((command): ChatTurn => ({
            commandId: command.id,
            source: "WEB",
            text: command.rawText,
            reply: command.replyText,
            replyStatus: command.replyStatus,
            departmentKey: departmentKeyFromParsedIntent(command.parsedIntent),
            attachments: Array.isArray(command.attachments)
              ? (command.attachments as ChatAttachment[])
              : [],
            createdAt: command.createdAt.toISOString(),
          }))}
        />
      </div>
    </AppShell>
  );
}
