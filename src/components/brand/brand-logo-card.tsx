import Image from "next/image";
import { ImagePlus, Sparkles } from "lucide-react";

import { prisma } from "@/lib/prisma";
import {
  generateLogoAction,
  uploadLogoAction,
} from "@/server/actions/project-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// Logo yükleme/üretme, kaldırılan 3 adımlı kurulum sihirbazından buraya
// taşındı — marka varlıklarının doğal yeri Marka Beyni'nin Varlıklar sekmesi.
export async function BrandLogoCard({
  projectId,
  brandId,
}: {
  projectId: string;
  brandId: string;
}) {
  const dossier = await prisma.brandDossier.findUnique({
    where: { brandId },
    select: { logoAssetId: true },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <ImagePlus className="size-4" />
        </span>
        <CardTitle className="text-base">Logo</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {dossier?.logoAssetId ? (
          <div className="flex items-center justify-center rounded-xl bg-accent/40 p-4">
            <Image
              src={`/api/assets/${dossier.logoAssetId}`}
              alt="Marka logosu"
              width={128}
              height={128}
              unoptimized
              className="h-32 w-auto object-contain"
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Henüz logo yok. Dosya yükleyebilir ya da marka dosyasındaki
            konumlandırmadan yapay zekâ ile üretebilirsiniz.
          </p>
        )}

        <form action={uploadLogoAction} className="space-y-2">
          <input type="hidden" name="projectId" value={projectId} />
          <Input
            type="file"
            name="logo"
            accept="image/png,image/jpeg"
            required
          />
          <p className="text-xs text-muted-foreground">
            PNG veya JPEG, en fazla 5 MB.
          </p>
          <SubmitButton size="sm" variant="outline">
            Yükle
          </SubmitButton>
        </form>

        <form action={generateLogoAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <SubmitButton size="sm">
            <Sparkles className="size-4" />
            Yapay zekâ ile üret
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
