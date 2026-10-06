import type { AdsAccount, ProjectStatus } from "@prisma/client";

// Bir hesabın senkron turu boyunca taşınan bağlam.
export type SyncProject = {
  projectId: string;
  workspaceId: string;
  brandId: string;
  name: string;
  status: ProjectStatus;
};

export type SyncContext = {
  account: AdsAccount;
  accessToken: string;
  // "act_<id>"
  externalId: string;
  currency: string | null;
  // Hesabın IANA saat dilimi (bilinmiyorsa UTC).
  timezone: string;
  // Hesap gününe göre bugün (YYYY-MM-DD).
  today: string;
  now: Date;
  // Hesabın seçili olduğu projeler (uyarılar bunlara açılır).
  projects: SyncProject[];
  // Etiketsiz (dışarıda kurulmuş) nesnelerin yazıldığı proje.
  primaryProjectId: string | null;
};
