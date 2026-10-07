import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { GaPropertyLink } from "@prisma/client";

// GA-F8: Website sayfasının seçili (ek) mülkü, istek kapsamlı bir geçersiz
// kılma olarak tutulur; okuyucuların hepsine parametre eklemek yerine
// `primaryGaLink` önce buraya sorar. Kapsam dışında (sohbet araçları, işler,
// eylemler) hiçbir geçersiz kılma görünmez.

const storage = new AsyncLocalStorage<GaPropertyLink>();

// link null ise run() olduğu gibi çalışır (geçersiz kılma yok).
export function withSelectedGaLink<T>(
  link: GaPropertyLink | null,
  run: () => Promise<T>,
): Promise<T> {
  if (!link) return run();
  return storage.run(link, run);
}

// Yalnız aynı projenin bağı döner; başka projenin okuması etkilenmez.
export function selectedGaLinkFor(projectId: string): GaPropertyLink | null {
  const link = storage.getStore();
  return link && link.projectId === projectId ? link : null;
}
