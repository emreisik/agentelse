import { notFound, redirect } from "next/navigation";
import type { DepartmentKey } from "@prisma/client";

import { presentTurnReply } from "@/lib/chat-reply";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { DEPARTMENT_KEY } from "@/lib/labels";
import { findActiveRun, isRunLive } from "@/server/chat/run-registry";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import {
  entityHref,
  parseHubParams,
} from "@/components/hub-core/hub-core-params";
import { PanelShell } from "@/components/hub-core/panel-shell";
import { ProjectFlowView } from "@/components/hub-core/project-flow-view";
import {
  ProjectChat,
  type ChatAttachment,
  type ChatTurn,
} from "@/components/commands/project-chat";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { ownerOfCapability } from "@/server/agency/departments/department-registry";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import { getWorkspaceRightPanelData } from "@/components/workspace/workspace-right-panel-data";
import { WorkspaceRightPanel } from "@/components/workspace/workspace-right-panel";
import { BrandSummaryPanel } from "@/components/workspace/brand-summary-panel";
import { OutputsPanel } from "@/components/workspace/outputs-panel";
import { CalendarPanel } from "@/components/workspace/calendar-panel";
import { FilesPanel } from "@/components/workspace/files-panel";
import { getPendingDecisions } from "@/server/agency/pending-decisions";
import { computeNextSteps } from "@/server/agency/journey/next-steps";
import { withPlanSlots } from "@/server/agency/journey/plan-slots";
import { loadJourneySnapshot } from "@/server/agency/journey/snapshot";
import { GUIDE_PARAM, GUIDE_VALUE } from "@/lib/guided-setup/contract";
import { isGuidedSetupEnabled } from "@/server/guided-setup/flag";
import { loadDiscoveryHost } from "@/server/guided-discovery/host";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import {
  getProjectTimezone,
  todayInTimezone,
} from "@/server/chat/content-plan";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { WorkRepository } from "@/server/repositories/work.repository";
import { isWorksEnabled } from "@/server/works/flag";
import {
  decisionBelongsToWork,
  workOwnersByTask,
  type TaskOwner,
} from "@/server/works/scope";
import { loadBriefExtras } from "@/server/works/daily-brief";
import { loadAdsPulse } from "@/server/works/ads-pulse";
import {
  approvalIdOfCard,
  briefFactsFor,
  dayStartIso,
  variantCreativeIds,
} from "@/server/works/page-wave2";
import {
  applyWorkOverlays,
  loadWorkActivity,
  loadWorkOverlayInputs,
} from "@/server/works/page-overlays";
import { buildWorkHost } from "@/lib/works/host";
import {
  channelsWithoutWork,
  isTodayWork,
  resolveWorkParam,
  todayDayKeyOf,
  type WorkView,
} from "@/lib/works/work";
import { buildDailyBrief } from "@/lib/works/daily-brief";
import { buildAdsInsight } from "@/lib/works/ads-insight";
import { copyText } from "@/lib/works/copy";
import { excludeVariantPieces } from "@/lib/works/variants";
import type { ChannelConnections } from "@/lib/content-channels";
import { NewWorkOpener } from "@/components/works/new-work-opener";
import { WorkHeader } from "@/components/works/work-header";

// Card kinds a content-package task leaves in the chat over its life: the
// in-progress card, then its result or failure. creative-ready is also in the
// general creatives query (which only keeps the newest 40) — listing it here
// keeps a package's image from dropping out of the chat when older ones pile
// up, or when its row flips from loading to ready between the two queries.
// Rows matched by both queries are merged by id.
const PACKAGE_ROW_KINDS = [
  "creative-loading",
  "creative-ready",
  "creative-failed",
  "task-running",
  "task-result",
] as const;

// Command.parsedIntent is written as { card: IdeaEventCardData } on rows
// sourced from SYSTEM (see IdeaChatRepository) — on WEB rows it carries the
// command parser's output instead, so its shape can't be used without validation.
// pendingApprovalByCreativeId: if a "creative-ready" card is IN_REVIEW but
// doesn't carry an approvalId (legacy records generated BEFORE approvalId was
// added to execution-service.ts), it's backfilled here retroactively — so
// approvals already pending also show Approve/Reject in the chat, without
// needing a separate backfill script.
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

// For event messages tied to a SINGLE department (task/creative completion —
// see IdeaChatRepository.postSystemMessage), if parsedIntent.departmentKey is
// set it's shown in chat as a color strip (see project-chat.tsx,
// assistant-ui/thread.tsx). WEB-sourced rows never have departmentKey written
// (parsedIntent has the shape of ParsedIntent there — see
// command-service.ts attachParsedIntent) — in that case the department is
// derived from the task's capability (the fixed ownership map in
// department-registry.ts), so the "Task created" note can also show which
// department it went to.
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

// Root of the in-project experience — now the project chat itself (like
// ChatGPT's main screen: the left sidebar lists projects/chats, clicking a
// project opens its chat). Modules like Departments/Work/Signals are reached
// from the header's Advanced menu and the sidebar; when a panel is selected
// (`?panel=&sub=&entity=`, see hub-core-params.ts) that panel is rendered as
// full-page content IN PLACE OF the chat — not a modal.
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
  // Opt-in escape hatch to the old, isolated per-idea thread view
  // (ProjectFlowView/IdeaFlow) — only used when something explicitly links
  // to it with &thread=1 (see the `entity` branch below).
  const wantsThreadView =
    (Array.isArray(sp.thread) ? sp.thread[0] : sp.thread) === "1";

  // ?guide=setup opens the setup sheet on landing. It is read only for the
  // chat below: the panel and entity branches return earlier and ignore it.
  const guideRaw = Array.isArray(sp[GUIDE_PARAM])
    ? sp[GUIDE_PARAM][0]
    : sp[GUIDE_PARAM];
  const guideRequested = guideRaw === GUIDE_VALUE;

  if (panel) {
    // The chat the panel was opened from (Works only): "Back to chat" returns
    // to it, because the bare project URL starts a new chat.
    const fromWork = isWorksEnabled()
      ? (Array.isArray(sp.work) ? sp.work[0] : sp.work)?.trim() || undefined
      : undefined;
    return (
      <AppShell projectId={projectId}>
        <PanelShell
          projectId={projectId}
          panel={panel}
          sub={sub}
          entity={entity}
          workId={fromWork}
        />
      </AppShell>
    );
  }

  // A bare `?entity=kind:id` link (no `panel`) — an old bookmark or a
  // cross-link. Idea/work pipeline events no longer live in the general
  // chat (it only shows the user's own requests), so this forwards to the
  // panel that owns the record instead. &thread=1 is the opt-in exception:
  // it falls through to the isolated, read-only ProjectFlowView below.
  if (entity) {
    if (!wantsThreadView) redirect(entityHref(projectId, entity));
    return (
      <AppShell projectId={projectId}>
        <ProjectFlowView projectId={projectId} entity={entity} />
      </AppShell>
    );
  }

  // Works (docs/works.md): the conversation on screen is one Work. `?work=`
  // names it (`today` is the alias of the day's Today Work). The bare URL, what
  // opening the project lands on, always starts a new chat: the opener reuses
  // the project's empty Work when there is one and moves into it. A stale
  // `?work=` goes back to the bare URL.
  let work: WorkView | null = null;
  let timezone = "Europe/Istanbul";
  let todayKey = "";
  if (isWorksEnabled()) {
    timezone = await getProjectTimezone(projectId).catch(() => timezone);
    todayKey = todayInTimezone(timezone);
    const requested = Array.isArray(sp.work) ? sp.work[0] : sp.work;
    const param = resolveWorkParam(requested, todayKey);
    if (param.kind === "today") {
      work = await WorkRepository.findToday(projectId, todayKey);
      if (!work) {
        return (
          <AppShell projectId={projectId}>
            <NewWorkOpener projectId={projectId} mode="today" />
          </AppShell>
        );
      }
    } else if (param.kind === "id") {
      work = await WorkRepository.get(projectId, param.id);
      if (!work) redirect(`/projects/${projectId}`);
    } else {
      return (
        <AppShell projectId={projectId}>
          <NewWorkOpener projectId={projectId} />
        </AppShell>
      );
    }
  }
  // Today Work: project-wide by definition, and live only on its own day.
  const isToday = work ? isTodayWork(work) : false;
  const workDay = work ? todayDayKeyOf(work.id) : null;
  const staleDay = isToday && workDay !== todayKey;

  const [
    project,
    chatCommands,
    publishTargets,
    rightPanelData,
    currentUser,
    decisions,
    discovery,
    journey,
    creativeCommands,
    [connections, activity, briefExtras, adsPulse, untouched],
  ] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    prisma.command.findMany({
      // The Agency Desk only shows the user's own planning/requests and the
      // assistant's replies to them — SYSTEM pipeline events (ideas,
      // council, work plans, task/creative results, reports) live in the
      // Ideas/Work panels, not here. ideaId: null drops messages typed
      // inside an idea's isolated thread; topic: null drops legacy scoped
      // threads (e.g. "BRAND_BRAIN" from the removed Brand Brain chat).
      where: {
        projectId,
        topic: null,
        ideaId: null,
        source: "WEB",
        ...(work ? { workId: work.id } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 72,
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
    getPublishTargets(projectId),
    getWorkspaceRightPanelData(projectId),
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    }),
    getPendingDecisions(projectId),
    // Discovery-first setup host (it replaces the old wizard host, which is
    // no longer mounted). Never throws (undefined on any failure: the chat
    // renders without the feature). Flag off: nothing is read.
    isGuidedSetupEnabled()
      ? loadDiscoveryHost(projectId, guideRequested)
      : Promise.resolve(undefined),
    // Where every piece of the saved content plans stands, and what to do
    // next. Never throws (null on any failure: the chat shows its default
    // shortcuts and plain plan cards).
    work && !isToday
      ? loadJourneySnapshot(projectId, { workId: work.id })
      : loadJourneySnapshot(projectId),
    // Every creative the pipeline ever produced stays in the conversation as
    // the same creative-ready card (SYSTEM rows, whichever idea they belong
    // to — the rest of the pipeline noise stays out of this chat). The
    // stored card is kept current by IdeaChatRepository (status, publish
    // state), so history and new creatives look and behave identically.
    prisma.command.findMany({
      where: {
        projectId,
        topic: null,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "kind"], equals: "creative-ready" },
        ...(work ? { workId: work.id } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 40,
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
    // Works only: the reads of the Work's own screen. The brief's extras and
    // the ads pulse are DB-only (no network); Today's brief is skipped on a
    // stale day. They depend on the Work alone, so they load with the rest.
    work
      ? Promise.all([
          getChannelConnections(projectId).catch((): ChannelConnections => ({})),
          loadWorkActivity(projectId, work.id),
          isToday && !staleDay
            ? loadBriefExtras(projectId, timezone, todayKey)
            : Promise.resolve(null),
          isToday || work.channels.includes("ads")
            ? loadAdsPulse(projectId)
            : Promise.resolve(null),
          // Still the new chat: the sidebar marks New Chat (not clickable) for it.
          WorkRepository.isUntouched(projectId, work.id).catch(() => false),
        ] as const)
      : Promise.resolve([
          {} as ChannelConnections,
          { working: false },
          null,
          null,
          false,
        ] as const),
  ]);

  if (!project) notFound();

  const firstName = (currentUser?.name ?? currentUser?.email ?? "").split(
    /[\s@]/,
  )[0];

  // creativeId → open approval, to (re)attach Approve/Reject to the newest
  // card of a creative that is still awaiting a decision.
  const pendingApprovalByCreativeId = new Map(
    decisions.flatMap((d) =>
      d.card.kind === "creative-ready"
        ? [[d.card.creativeId, d.approvalId] as const]
        : [],
    ),
  );
  // A revision posts a NEW card and leaves the earlier version's card
  // untouched — only the newest card per creative may keep a live decision.
  const newestCardByCreativeId = new Map<string, string>();
  for (const command of creativeCommands) {
    const card = cardFromParsedIntent(command.parsedIntent);
    if (card?.kind === "creative-ready" && !newestCardByCreativeId.has(card.creativeId)) {
      newestCardByCreativeId.set(card.creativeId, command.id);
    }
  }

  // Everything a content package's tasks post to the chat — the running /
  // loading card while a piece is being made, then its result (SEO article,
  // Reel script...) or failure — is pulled into the conversation, so a piece
  // is visible from the moment it starts, also after a reload.
  // (A saved content plan's production runs its tasks under the plan's own
  // Command, exactly like a package does.)
  const packageCommandIds = chatCommands
    .filter((command) => {
      const kind = cardFromParsedIntent(command.parsedIntent)?.kind;
      return kind === "content-package" || kind === "content-plan-draft";
    })
    .map((command) => command.id);
  const loadPackageRows = async () => {
    const packageTaskIds = packageCommandIds.length
      ? (
          await prisma.task.findMany({
            where: { projectId, commandId: { in: packageCommandIds } },
            select: { id: true },
          })
        ).map((task) => task.id)
      : [];
    const packageRowCommands = packageTaskIds.length
      ? await prisma.command.findMany({
          where: {
            projectId,
            topic: null,
            source: "SYSTEM",
            AND: [
              {
                OR: PACKAGE_ROW_KINDS.map((kind) => ({
                  parsedIntent: { path: ["card", "kind"], equals: kind },
                })),
              },
              {
                OR: packageTaskIds.map((taskId) => ({
                  parsedIntent: { path: ["card", "taskId"], equals: taskId },
                })),
              },
            ],
          },
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
        })
      : [];
    return packageRowCommands;
  };

  // In a Work, only the decisions that belong to it (started here) or to no
  // Work at all; the others wait in the Work that asked for them. An unowned
  // real-money Meta proposal shows in a Work that chose ads, in Today, or in
  // every Work when no active Work covers ads.
  const decisionTaskIdOf = (d: (typeof decisions)[number]): string | undefined =>
    "taskId" in d.card && typeof d.card.taskId === "string"
      ? d.card.taskId
      : undefined;
  const decisionTaskIds = work
    ? decisions.flatMap((d) => decisionTaskIdOf(d) ?? [])
    : [];
  // The package rows and the decisions' owners are independent: one wait.
  const [packageRowCommands, [decisionOwners, coverage]] = await Promise.all([
    loadPackageRows(),
    work
      ? Promise.all([
          workOwnersByTask(projectId, decisionTaskIds),
          WorkRepository.channelCoverage(projectId).catch(() => []),
        ])
      : Promise.resolve([new Map<string, TaskOwner>(), []] as const),
  ]);
  // A creative's card can match both queries — one row, one message.
  const rowsById = new Map(
    [...chatCommands, ...creativeCommands, ...packageRowCommands].map(
      (command) => [command.id, command] as const,
    ),
  );
  const anyActiveWorkCoversAds = coverage.some(
    (w) => w.status === "ACTIVE" && w.channels.includes("ads"),
  );
  const workDecisions = decisions.filter((d) => {
    if (!work) return true;
    const taskId = decisionTaskIdOf(d);
    return decisionBelongsToWork({
      workId: work.id,
      channels: work.channels,
      isToday,
      taskId,
      owner: taskId ? decisionOwners.get(taskId) : undefined,
      anyActiveWorkCoversAds,
    });
  });
  // Works only: live state of the cards on screen (the decision cards
  // included: a pending-decision creative card would promise "Approve &
  // publish" for a piece the hold rule will hold).
  const overlayInputs = work
    ? await loadWorkOverlayInputs(projectId, [
        ...[...rowsById.values()].map((c) => cardFromParsedIntent(c.parsedIntent)),
        ...workDecisions.map((d) => d.card),
      ])
    : null;
  const stageByCreativeId = new Map(
    (journey?.items ?? []).map((item) => [item.id, item] as const),
  );
  const hasAnalytics = rightPanelData.connections.some(
    (account) =>
      (account.key === "ga4" ||
        account.key === "search-console" ||
        account.key === "meta-ads") &&
      account.state === "connected",
  );
  // A pending-decision creative card is the newest card of its piece.
  const decisionCardOf = (d: (typeof workDecisions)[number]) =>
    overlayInputs
      ? applyWorkOverlays(d.card, overlayInputs, { isNewestCreativeCard: true })
      : d.card;
  const chatTurns = [...rowsById.values()]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((command): ChatTurn => {
      let card = withPlanSlots(
        cardFromParsedIntent(command.parsedIntent, pendingApprovalByCreativeId),
        stageByCreativeId,
      );
      if (
        card?.kind === "creative-ready" &&
        card.status === "IN_REVIEW" &&
        newestCardByCreativeId.get(card.creativeId) !== command.id
      ) {
        card = { ...card, status: "ARCHIVED", approvalId: undefined };
      }
      // The channel question is answered once the Work has channels: the card
      // then reads as a resolved line instead of asking again after a reload.
      if (
        work &&
        card?.kind === "channel-select" &&
        work.channels.length > 0
      ) {
        card = { ...card, selected: work.channels };
      }
      // Live overlays go last, so an older card the page archived above (a
      // revised piece) is never revived by the live row.
      if (overlayInputs) {
        card = applyWorkOverlays(card, overlayInputs, {
          isNewestCreativeCard:
            card?.kind === "creative-ready"
              ? newestCardByCreativeId.get(card.creativeId) === command.id
              : true,
        });
      }
      return {
        commandId: command.id,
        source: command.source as "WEB" | "SYSTEM",
        text: command.rawText,
        // A turn still RUNNING whose run is gone (restart, deploy) reads as
        // interrupted; a live one stays RUNNING and the chat re-attaches.
        ...presentTurnReply(command, isRunLive(command.id)),
        departmentKey: departmentKeyFromParsedIntent(command.parsedIntent),
        // Limit-notice cards are also written to WEB-sourced rows (see
        // chat-service.ts) — without this, the card would only show
        // until the next refresh, then fall back to plain text.
        card,
        attachments: Array.isArray(command.attachments)
          ? (command.attachments as ChatAttachment[])
          : [],
        createdAt: command.createdAt.toISOString(),
      };
    });

  // Next steps. In a Work, a bulk "Approve n" leaves out the pieces that still
  // have unchosen picture alternatives (they stay in the Review step one by
  // one); Today reads the project-wide journey loaded above.
  const baseNextSteps = journey ? computeNextSteps(journey) : [];
  const nextSteps = work
    ? excludeVariantPieces(
        baseNextSteps,
        variantCreativeIds([
          ...chatTurns.map((t) => t.card),
          ...workDecisions.map(decisionCardOf),
        ]),
      )
    : baseNextSteps;

  // Live turns of a Work: the daily brief (Today, its own day only) and the
  // Meta Ads card. Built on every render from real rows and never stored.
  // A new chat (untouched) stays empty, like ChatGPT's: with a card in it, it
  // would look used while it is still "New Chat" and not in Recents. Its first
  // message makes it a chat; the cards show from then on (Today always).
  const liveTurns: ChatTurn[] = [];
  if (work && !untouched) {
    const liveAt = dayStartIso(workDay ?? todayKey, timezone);
    if (briefExtras) {
      liveTurns.push({
        commandId: `brief-${work.id}`,
        source: "SYSTEM",
        text: "",
        reply: "Daily brief",
        replyStatus: null,
        card: buildDailyBrief(
          briefFactsFor({
            projectId,
            today: todayKey,
            timezone,
            now: new Date(),
            connections,
            hasAnalytics,
            extras: briefExtras,
            journey,
            nextSteps,
            goalTitle: rightPanelData.brand?.currentFocus?.title,
            channelsWithoutWork: channelsWithoutWork(connections, coverage),
          }),
        ),
        attachments: [],
        createdAt: liveAt,
      });
    }
    if (adsPulse) {
      liveTurns.push({
        commandId: `ads-${work.id}`,
        source: "SYSTEM",
        text: "",
        reply: copyText("ads.heading"),
        replyStatus: null,
        card: buildAdsInsight(adsPulse, new Date()),
        attachments: [],
        createdAt: liveAt,
      });
    }
  }

  // Pending approvals are decided inside the conversation. A creative that
  // already has its card above is decided there (so is a proposal the ads
  // card shows); anything else (task approvals, creatives with no chat card)
  // is appended at the bottom as the same card, rebuilt from the records.
  // Oldest first; a decided one drops out on router.refresh().
  const shownApprovalIds = new Set(
    [...liveTurns, ...chatTurns].flatMap((t) => approvalIdOfCard(t.card) ?? []),
  );
  const decisionTurns = (untouched ? [] : workDecisions)
    .filter((d) => !shownApprovalIds.has(d.approvalId))
    .map(
      (d): ChatTurn => ({
        commandId: `decision-${d.approvalId}`,
        source: "SYSTEM",
        text: "",
        reply: "Waiting for your decision",
        replyStatus: null,
        card: decisionCardOf(d),
        attachments: [],
        createdAt: d.createdAt,
      }),
    );
  const turns = [...liveTurns, ...chatTurns, ...decisionTurns];

  // The Work's header line and its empty screen (channel chooser / cards).
  let workHost: ReturnType<typeof buildWorkHost> | undefined;
  let workHeader: React.ReactNode = null;
  if (work) {
    workHost = buildWorkHost({
      projectId,
      work,
      connections,
      timezone,
      today: journey?.today ?? todayInTimezone(timezone),
      theme: rightPanelData.brand?.currentFocus?.title,
      aiOff: ReasoningService.isMockMode(),
      pendingApprovals: decisionTurns.length,
      hasAnalytics,
    });
    workHeader = (
      <WorkHeader
        projectId={projectId}
        workId={work.id}
        title={work.title}
        status={work.status}
        working={activity.working}
        isToday={isToday}
        staleDay={staleDay}
        untouched={untouched}
      />
    );
  }

  const chat = (
    <ProjectChat
      projectId={projectId}
      chatEngine={getEnv().CHAT_ENGINE}
      projectName={project.name}
      userFirstName={firstName || null}
      publishTargets={publishTargets}
      turns={turns}
      discovery={discovery}
      nextSteps={nextSteps}
      autoNext={typeof sp.next === "string" ? sp.next : undefined}
      workHost={workHost}
      liveRunCommandId={
        findActiveRun(projectId, work?.id ?? null)?.commandId ?? undefined
      }
    />
  );

  return (
    <AppShell
      projectId={projectId}
      openWorkUntouched={untouched}
      rightPanel={
        <WorkspaceRightPanel
          brand={
            <BrandSummaryPanel
              projectId={projectId}
              brand={rightPanelData.brand}
              website={rightPanelData.website}
              kit={rightPanelData.brandKit}
              connections={rightPanelData.connections}
            />
          }
          files={
            <FilesPanel projectId={projectId} assets={rightPanelData.files} />
          }
          outputs={
            <OutputsPanel
              projectId={projectId}
              timezone={rightPanelData.calendar.timezone}
            />
          }
          calendar={
            <CalendarPanel
              projectId={projectId}
              timezone={rightPanelData.calendar.timezone}
            />
          }
        />
      }
    >
      {work ? (
        <div key={`work-${work.id}`} className="flex h-full flex-col">
          {workHeader}
          <div className="relative min-h-0 flex-1">{chat}</div>
        </div>
      ) : (
        <div key="project-general" className="relative h-full">
          {chat}
        </div>
      )}
    </AppShell>
  );
}
