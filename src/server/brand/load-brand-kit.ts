import { prisma } from "@/lib/prisma";
import { buildBrandKit, type BrandKit } from "@/lib/brand-kit";
import { parseColorSwatches, parseFontNames } from "@/lib/color-swatches";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";

// The brand's whole look as one read model (both logo variants, role-split
// colours, fonts, style, post template and saved layouts). Brand Brain's Assets
// and Visual Identity tabs both read it, so a colour never shows differently in
// two places: the Visual Identity colours when the brand has set them, else
// the dossier's approved colours.
export async function loadBrandKit(brandId: string): Promise<BrandKit> {
  const [style, dossier] = await Promise.all([
    resolveBrandStyleContext(brandId),
    prisma.brandDossier.findUnique({
      where: { brandId },
      select: { approvedFonts: true },
    }),
  ]);
  return buildBrandKit({
    legacyColors: parseColorSwatches(style.legacyApprovedColors),
    fonts: parseFontNames(dossier?.approvedFonts),
    logoAssetId: style.logoAssetId,
    darkLogoAssetId: style.darkLogoAssetId,
    identity: style.visualIdentity,
  });
}
