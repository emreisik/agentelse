// SC-F8: WordPress REST yanıtlarının ayrıştırılmış, sade biçimi. P3 (istemci)
// bu tipleri buradan içe aktarır. Saf dosya.

import type { WpType } from "../types";

// context=edit biçiminden türetilir; modified, modified_gmt + "Z" (ISO UTC).
export type WpObject = {
  id: number;
  type: WpType;
  status: string;
  link: string;
  slug: string;
  modified: string;
  // title.raw ?? title.rendered
  title: string;
  excerpt: string;
  // content.raw; korumalı ya da okunamayan içerikte null.
  content: string | null;
  meta: Record<string, unknown>;
};

// GET /wp-json/ (REST dizini).
export type WpIndex = {
  name: string | null;
  url: string | null;
  namespaces: string[];
  // authentication["application-passwords"] var mı.
  appPasswords: boolean;
};

// GET /wp/v2/users/me?context=edit
export type WpMe = {
  id: number;
  name: string | null;
  roles: string[];
  capabilities: Record<string, boolean>;
};
