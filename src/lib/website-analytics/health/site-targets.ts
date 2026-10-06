import { isValidDomain, normalizeDomain } from "@/lib/domain";

// GA-F3 site taraması hedefleri (docs/measurement-health.md "Site
// taraması"): yalnız projenin kendi alan adı (Project.domain). GA akışının
// adresi asla kullanılmaz: yanlış mülk tam da MH21'in yakaladığı durumdur.
// Yollar: ana sayfa + en çok 5 düz açılış sayfası (sorgu, parça, maske ya da
// boşluk içermeyen). Açılış yolları GA verisidir: yalnız GA akışının adresi
// (streamUri) Project.domain ile aynı siteyse (www ikizi dahil) eklenir;
// aksi hâlde mülkün popüler yolları başka bir sunucuya gitmesin diye yalnız
// ana sayfa taranır.

export const MAX_SITE_SCAN_PATHS = 6;

const MAX_PATH_LENGTH = 300;

function plainPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    path !== "(not set)" &&
    path.length <= MAX_PATH_LENGTH &&
    !/[[?#\s]/.test(path)
  );
}

function streamHostOf(streamUri: string | null | undefined): string | null {
  if (!streamUri) return null;
  try {
    return normalizeDomain(new URL(streamUri).hostname);
  } catch {
    return null;
  }
}

export function siteTagTargets(input: {
  projectDomain: string | null;
  landingPaths: string[];
  streamUri?: string | null;
}): { host: string; paths: string[] } | null {
  const domain = input.projectDomain;
  if (!domain || !isValidDomain(domain)) return null;
  const host = normalizeDomain(domain);

  const paths = new Set<string>(["/"]);
  if (streamHostOf(input.streamUri) !== host) {
    return { host, paths: Array.from(paths) };
  }
  for (const path of input.landingPaths) {
    if (paths.size >= MAX_SITE_SCAN_PATHS) break;
    if (typeof path === "string" && plainPath(path)) paths.add(path);
  }
  return { host, paths: Array.from(paths) };
}
