"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import type { ActionResult } from "@/components/shared/action-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type GoalEditable = {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  targetValue: number | null;
};

// Inline edit dialog for a project goal; submits the server action and
// closes on success (RSC revalidation refreshes the list behind it).
export function GoalEditDialog({
  projectId,
  goal,
  action,
}: {
  projectId: string;
  goal: GoalEditable;
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        toast.success("Hedef güncellendi");
        setOpen(false);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setOpen(true)}
        aria-label="Hedefi düzenle"
      >
        <Pencil className="size-3.5" />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Hedefi Düzenle</DialogTitle>
          <DialogDescription>
            Başlık, öncelik ve hedef değeri güncelleyin.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="goalId" value={goal.id} />
          <div className="space-y-1.5">
            <Label htmlFor={`goal-title-${goal.id}`}>Başlık</Label>
            <Input
              id={`goal-title-${goal.id}`}
              name="title"
              defaultValue={goal.title}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`goal-desc-${goal.id}`}>Açıklama</Label>
            <Textarea
              id={`goal-desc-${goal.id}`}
              name="description"
              defaultValue={goal.description ?? ""}
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`goal-priority-${goal.id}`}>Öncelik (1-5)</Label>
              <Input
                id={`goal-priority-${goal.id}`}
                name="priority"
                type="number"
                min={1}
                max={5}
                defaultValue={goal.priority}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`goal-target-${goal.id}`}>Hedef değer</Label>
              <Input
                id={`goal-target-${goal.id}`}
                name="targetValue"
                type="number"
                step="any"
                defaultValue={goal.targetValue ?? ""}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Vazgeç
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Kaydet
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
