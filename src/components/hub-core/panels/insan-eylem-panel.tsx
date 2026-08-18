import { UserRoundCog } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { timeAgo } from "@/lib/dates";
import { HUMAN_INTERVENTION_TYPE } from "@/lib/labels";
import {
  cancelHumanActionAction,
  resolveHumanActionAction,
} from "@/server/actions/human-action-actions";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PanelProps } from "./panel-props";

// Eskiden /human-actions (workspace geneli, proje bağlamının DIŞINDA, hiç
// projectId filtresi olmayan ayrı bir sayfa) altında yaşayan İnsan Eylem
// Merkezi — artık her projenin kendi Araçlar menüsünden açılan bir panel,
// SADECE o projenin bekleyen talepleri (bkz. onaylar-panel.tsx'teki aynı
// dönüşüm).
export async function InsanEylemPanel({ projectId }: PanelProps) {
  const requests = await prisma.humanInterventionRequest.findMany({
    where: { projectId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-3">
      {requests.map((request) => (
        <Card key={request.id} className="transition-shadow hover:shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{request.title}</CardTitle>
            <StatusBadge
              meta={HUMAN_INTERVENTION_TYPE[request.type]}
              fallback={request.type}
            />
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{request.message}</p>
            <p className="text-xs text-muted-foreground">
              {timeAgo(request.createdAt)}
              {request.expiresAt
                ? ` · Son geçerlilik: ${timeAgo(request.expiresAt)}`
                : ""}
            </p>

            {request.inputType === "MANUAL_BROWSER" ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  title="Uzak tarayıcı oturumu bağlantısı henüz mevcut değil"
                >
                  Tarayıcıyı Aç
                </Button>
                <ActionForm
                  action={cancelHumanActionAction}
                  successMessage="Görev iptal edildi"
                >
                  <input type="hidden" name="requestId" value={request.id} />
                  <SubmitButton variant="ghost" size="sm">
                    Görevi İptal Et
                  </SubmitButton>
                </ActionForm>
              </div>
            ) : (
              <ActionForm
                action={resolveHumanActionAction}
                successMessage="Yanıt gönderildi"
                className="flex items-center gap-2"
              >
                <input type="hidden" name="requestId" value={request.id} />
                <Input
                  name="value"
                  placeholder={
                    request.inputType === "OTP" ? "Kodu girin" : "Değeri girin"
                  }
                  className="max-w-48"
                />
                <SubmitButton size="sm">Gönder</SubmitButton>
              </ActionForm>
            )}
          </CardContent>
        </Card>
      ))}

      {requests.length === 0 ? (
        <EmptyState
          icon={UserRoundCog}
          title="Bekleyen insan eylemi yok"
          hint="Ajanlar bir doğrulama koduna veya manuel müdahaleye ihtiyaç duyduğunda burada görünür."
        />
      ) : null}
    </div>
  );
}
