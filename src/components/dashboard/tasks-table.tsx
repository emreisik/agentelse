import Link from "next/link";
import type { TaskStatus } from "@prisma/client";

import { timeAgo } from "@/lib/dates";
import {
  TASK_STATUS,
  capabilityLabel,
  stripCapabilityPrefix,
} from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/status-badge";

export function TasksTable({
  tasks,
}: {
  tasks: {
    id: string;
    title: string;
    projectId: string;
    projectName: string;
    capability: string;
    status: TaskStatus;
    updatedAt: Date;
  }[];
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Görevler</CardTitle>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz görev yok.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Görev</TableHead>
                <TableHead>Proje</TableHead>
                <TableHead>Yetenek</TableHead>
                <TableHead>Durum</TableHead>
                <TableHead className="text-right">Güncelleme</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell className="max-w-56 truncate font-medium">
                    <Link
                      href={`/projects/${task.projectId}?panel=isler&sub=gorevler&entity=task:${task.id}`}
                      className="hover:underline"
                    >
                      {stripCapabilityPrefix(task.title)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/projects/${task.projectId}`}
                      className="text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {task.projectName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {capabilityLabel(task.capability)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge meta={TASK_STATUS[task.status]} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {timeAgo(task.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
