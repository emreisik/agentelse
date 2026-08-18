import Link from "next/link";
import { ArrowLeft, Building2, Lightbulb, TriangleAlert } from "lucide-react";
import type { DepartmentKey, DepartmentMode } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import {
  ALL_DEPARTMENT_KEYS_UI,
  DEPARTMENT_COLOR,
  DEPARTMENT_KEY,
  DEPARTMENT_MODE,
  DEPARTMENT_MODE_HINT,
  capabilityLabel,
} from "@/lib/labels";
import { updateDepartmentModeAction } from "@/server/actions/agency-config-actions";
import { DEPARTMENTS } from "@/server/agency/departments/department-registry";
import { EmptyState } from "@/components/shared/empty-state";
import { ModeSwitcher } from "@/components/shared/mode-switcher";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildHubHref } from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import type { PanelProps } from "./panel-props";

// The "active task" status set also used by work-panel — the in-progress
// stages on Task.status (used for the counter on department cards).
const ACTIVE_TASK_STATUSES = [
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_HUMAN",
  "WAITING_APPROVAL",
  "WAITING_PROVIDER",
  "VERIFYING",
] as const;

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    typeof item === "string" ? item : JSON.stringify(item),
  );
}

function modeOptions() {
  return (Object.keys(DEPARTMENT_MODE) as DepartmentMode[]).map((mode) => ({
    value: mode,
    label: DEPARTMENT_MODE[mode].label,
    hint: DEPARTMENT_MODE_HINT[mode],
  }));
}

export async function DepartmentsPanel({ projectId, entity }: PanelProps) {
  if (entity && entity.kind === "department" && entity.id in DEPARTMENT_KEY) {
    return (
      <DepartmentDetail
        projectId={projectId}
        department={entity.id as DepartmentKey}
      />
    );
  }

  return <DepartmentList projectId={projectId} />;
}

// ---------------------------------------------------------------------------

async function DepartmentList({ projectId }: { projectId: string }) {
  const [departments, audits, taskCountsRaw] = await Promise.all([
    prisma.projectDepartment.findMany({ where: { projectId } }),
    prisma.baselineAudit.findMany({
      where: { projectId },
      select: { department: true, score: true },
    }),
    prisma.task.groupBy({
      by: ["departmentKey"],
      where: {
        projectId,
        departmentKey: { not: null },
        status: { in: [...ACTIVE_TASK_STATUSES] },
      },
      _count: { id: true },
    }),
  ]);

  const departmentByKey = new Map(departments.map((d) => [d.department, d]));
  const auditScore = new Map(audits.map((a) => [a.department, a.score]));
  const activeTaskCount = new Map(
    taskCountsRaw
      .filter((t) => t.departmentKey !== null)
      .map((t) => [t.departmentKey as DepartmentKey, t._count.id]),
  );

  if (departments.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          icon={Building2}
          title="No department configuration"
          hint="The 19 departments' operating modes are configured in step 7 of setup."
        />
      </div>
    );
  }

  const options = modeOptions();
  const islerHref = buildHubHref(projectId, {
    panel: "work",
    sub: "tasks",
  });

  return (
    <div className="space-y-4 py-6">
      <p className="text-sm text-muted-foreground">
        Operating mode and audit score for the 19 departments.
      </p>

      <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead className="text-right">Active tasks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ALL_DEPARTMENT_KEYS_UI.map((key) => {
              const meta = DEPARTMENT_KEY[key];
              const Icon = meta.icon;
              const row = departmentByKey.get(key);
              const score = auditScore.get(key);
              const activeCount = activeTaskCount.get(key) ?? 0;
              const modeMismatch =
                row?.recommendedMode && row.recommendedMode !== row.mode;
              const detailHref = buildHubHref(projectId, {
                panel: "departments",
                entity: { kind: "department", id: key },
              });

              return (
                <TableRow key={key}>
                  <TableCell>
                    <Link
                      href={detailHref}
                      scroll={false}
                      className="flex min-w-0 items-center gap-2 font-medium hover:underline"
                    >
                      {Icon ? (
                        <Icon
                          className="size-4 shrink-0"
                          style={{ color: DEPARTMENT_COLOR[key] }}
                        />
                      ) : null}
                      <span className="truncate">{meta.label}</span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    {score !== undefined ? (
                      <span
                        className={cn(
                          "flex h-6 w-fit items-center rounded-md px-2 text-xs font-semibold tabular-nums",
                          score >= 70
                            ? "bg-success/15 text-success"
                            : score >= 40
                              ? "bg-warning/15 text-warning"
                              : "bg-destructive/15 text-destructive",
                        )}
                      >
                        {score}/100
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {row ? (
                      <div className="flex items-center gap-1.5">
                        <ModeSwitcher
                          value={row.mode}
                          options={options}
                          action={updateDepartmentModeAction}
                          hiddenFields={{ projectId, department: key }}
                          fieldName="mode"
                          successMessage={`${meta.label} mode updated`}
                        />
                        {modeMismatch && row.recommendedMode ? (
                          <span
                            title={`Recommended mode: ${DEPARTMENT_MODE[row.recommendedMode].label}${row.recommendationRationale ? ` — ${row.recommendationRationale}` : ""}`}
                          >
                            <Lightbulb className="size-3.5 shrink-0 text-warning" />
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">
                        Not configured
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {activeCount > 0 ? (
                      <Link
                        href={islerHref}
                        scroll={false}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {activeCount}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

async function DepartmentDetail({
  projectId,
  department,
}: {
  projectId: string;
  department: DepartmentKey;
}) {
  const [row, audit] = await Promise.all([
    prisma.projectDepartment.findUnique({
      where: { projectId_department: { projectId, department } },
    }),
    prisma.baselineAudit.findUnique({
      where: { projectId_department: { projectId, department } },
    }),
  ]);

  const meta = DEPARTMENT_KEY[department];
  const Icon = meta.icon;
  const definition = DEPARTMENTS[department];

  const findingIds = audit?.findingIds ?? [];
  const findings = findingIds.length
    ? await prisma.finding.findMany({
        where: { id: { in: findingIds } },
        select: { id: true, statement: true },
      })
    : [];

  const rowFields: FieldSpec[] = [
    {
      type: "badge",
      label: "Recommended Mode",
      meta: row?.recommendedMode
        ? DEPARTMENT_MODE[row.recommendedMode]
        : undefined,
      fallback: "—",
    },
    {
      type: "text",
      label: "Recommendation Rationale",
      value: row?.recommendationRationale,
    },
    { type: "date", label: "Created", value: row?.createdAt },
    {
      type: "date",
      label: "Updated",
      value: row?.updatedAt,
      relative: true,
    },
  ];

  const auditFields: FieldSpec[] = audit
    ? [
        { type: "boolean", label: "Demo Data (mock)", value: audit.isMock },
        { type: "date", label: "Created", value: audit.createdAt },
        {
          type: "date",
          label: "Updated",
          value: audit.updatedAt,
          relative: true,
        },
      ]
    : [];

  const sections: Array<{ label: string; items: string[]; tone: string }> = [
    {
      label: "Strengths",
      items: stringList(audit?.strengths),
      tone: "text-success",
    },
    {
      label: "Weaknesses",
      items: stringList(audit?.weaknesses),
      tone: "text-warning",
    },
    {
      label: "Risks",
      items: stringList(audit?.risks),
      tone: "text-destructive",
    },
    {
      label: "Potential Opportunities",
      items: stringList(audit?.potentialOpportunities),
      tone: "text-primary",
    },
  ];

  return (
    <div className="space-y-6 py-6">
      <Link
        href={buildHubHref(projectId, {
          panel: "departments",
          entity: null,
        })}
        scroll={false}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to list
      </Link>

      <div className="flex items-center gap-2.5">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor: `color-mix(in oklch, ${DEPARTMENT_COLOR[department]} 15%, transparent)`,
            color: DEPARTMENT_COLOR[department],
          }}
        >
          {Icon ? <Icon className="size-4" /> : null}
        </span>
        <h3 className="font-heading text-lg font-semibold text-foreground">
          {meta.label}
        </h3>
      </div>

      {row ? (
        <Card size="sm">
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">
                Operating Mode
              </span>
              <ModeSwitcher
                value={row.mode}
                options={modeOptions()}
                action={updateDepartmentModeAction}
                hiddenFields={{ projectId, department }}
                fieldName="mode"
                successMessage={`${meta.label} mode updated`}
              />
            </div>
            <FieldGrid fields={rowFields} />
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={Building2}
          title="This department is not configured"
          hint="The operating mode is set during setup."
        />
      )}

      {definition ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            Owned Capabilities
          </p>
          <div className="flex flex-wrap gap-1">
            {definition.ownedCapabilities.map((capability) => (
              <span
                key={capability}
                className="rounded-4xl bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {capabilityLabel(capability)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {audit ? (
        <Card
          size="sm"
          className={
            audit.score < 40 ? "ring-1 ring-destructive/30" : undefined
          }
        >
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "flex h-7 items-center rounded-md px-2.5 text-sm font-semibold tabular-nums",
                  audit.score >= 70
                    ? "bg-success/15 text-success"
                    : audit.score >= 40
                      ? "bg-warning/15 text-warning"
                      : "bg-destructive/15 text-destructive",
                )}
              >
                {audit.score}/100
              </span>
              {audit.isMock ? (
                <StatusBadge meta={{ label: "Demo data", tone: "special" }} />
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground">{audit.summary}</p>

            <FieldGrid fields={auditFields} />

            {sections.map((section) =>
              section.items.length > 0 ? (
                <div key={section.label} className="space-y-1.5">
                  <p className={cn("text-xs font-medium", section.tone)}>
                    {section.label}
                  </p>
                  <ul className="space-y-1 text-sm">
                    {section.items.map((item, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                        <span className="min-w-0">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}

            {findings.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">
                  Related Findings{" "}
                  <span className="text-muted-foreground">
                    ({findings.length})
                  </span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {findings.map((finding) => (
                    <CrossLinkChip
                      key={finding.id}
                      projectId={projectId}
                      entity={{ kind: "finding", id: finding.id }}
                      text={finding.statement}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {audit.score < 40 ? (
              <p className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                This department&apos;s current state is weak — the agency prioritizes
                generating opportunity and improvement recommendations in this
                area.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={TriangleAlert}
          title="No baseline audit"
          hint="No baseline audit has been generated for this department yet."
        />
      )}
    </div>
  );
}
