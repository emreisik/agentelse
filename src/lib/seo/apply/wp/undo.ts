// SC-F8: değişikliği geri alma planı (saf). Geri alma ikinci bir onay değil, sahibin
// açık tıklamasıdır; yine de canlı nesne bizden sonra değişmişse dokunulmaz
// (undoPrecondition). Silme yok: PUBLISH_ARTICLE'ın geri alınışı WordPress Çöp
// Kutusu'na taşır (zorla silme yok). Saf modül; snapshot.ts node:crypto kullanır
// (yalnız sunucu tarafı).

import type {
  SeoChangeKind,
  SeoChangeParams,
  SeoChangeStatus,
  SeoFieldsCapability,
  WpSnapshot,
  WpType,
} from "../types";
import { SEO_UNDO_WINDOW_MS, isUndoable } from "../lifecycle";
import { SEO_META_KEYS } from "./plugin-fields";
import { contentHashOf } from "./snapshot";
import type { WpObject } from "./wp-types";

export type UndoOp =
  | { op: "trash"; type: WpType; id: number }
  | { op: "unpublish"; type: WpType; id: number }
  | {
      op: "restore";
      type: WpType;
      id: number;
      body: { title?: string; content?: string; meta?: Record<string, string> };
      endpointMeta: Record<string, string> | null;
    };

type UndoChange = {
  kind: SeoChangeKind;
  noop: boolean;
  status: SeoChangeStatus;
  before: WpSnapshot | null;
  after: WpSnapshot | null;
  params: SeoChangeParams;
  appliedAt: Date | null;
};

function cannot(reason: string): { ok: false; code: "cannot_undo"; reason: string } {
  return { ok: false, code: "cannot_undo", reason };
}

function metaKeysOf(
  plugin: SeoFieldsCapability["plugin"],
): { title: string; description: string } | null {
  if (plugin === "YOAST") return SEO_META_KEYS.yoast;
  if (plugin === "RANK_MATH") return SEO_META_KEYS.rankMath;
  return null;
}

export function planUndo(
  change: UndoChange,
  ctx: { fields: SeoFieldsCapability; now: Date },
): { ok: true; undo: UndoOp } | { ok: false; code: "cannot_undo"; reason: string } {
  if (change.noop) return cannot("Nothing was written, so there is nothing to undo.");
  if (!change.appliedAt) return cannot("The change was never written.");
  if (ctx.now.getTime() - change.appliedAt.getTime() > SEO_UNDO_WINDOW_MS) {
    return cannot("The undo window has passed.");
  }
  if (
    !isUndoable(
      {
        kind: change.kind,
        status: change.status,
        noop: change.noop,
        appliedAt: change.appliedAt,
      },
      ctx.now,
    )
  ) {
    return cannot("This change cannot be undone in its current state.");
  }

  const params = change.params;
  switch (params.kind) {
    case "PUBLISH_ARTICLE": {
      // Kimlik yalnız yazma sonrası görüntüsünde bulunur; yoksa motor önce
      // searchDrafts ile benimsemeyi dener.
      const id = change.after?.id ?? null;
      if (id === null) return cannot("The WordPress draft could not be identified.");
      return { ok: true, undo: { op: "trash", type: "post", id } };
    }
    case "PUBLISH_LIVE":
      return {
        ok: true,
        undo: { op: "unpublish", type: params.wpType, id: params.wpId },
      };
    case "INTERNAL_LINKS": {
      const raw = change.before?.contentRaw ?? null;
      if (raw === null) {
        return cannot("The original page content is no longer kept.");
      }
      return {
        ok: true,
        undo: {
          op: "restore",
          type: params.wpType,
          id: params.wpId,
          body: { content: raw },
          endpointMeta: null,
        },
      };
    }
    case "TITLE_META": {
      const before = change.before;
      if (!before || !before.exists) {
        return cannot("The original title and description were not kept.");
      }
      const keys = metaKeysOf(ctx.fields.plugin);
      const body: { title?: string; meta?: Record<string, string> } = {};
      const meta: Record<string, string> = {};
      const endpoint: Record<string, string> = {};

      // Yalnız değişiklikle dokunulan alanlar; boş önceki değer "" ile geri yazılır
      // (Yoast'ta varsayılan şablona dönüş; doğrulanmalı).
      if (params.title !== null) {
        if (keys && ctx.fields.titleVia === "META") {
          meta[keys.title] = before.seoTitle ?? "";
        } else if (keys && ctx.fields.titleVia === "RANKMATH_ENDPOINT") {
          // Uç nokta alanı okunamadığı için önceki değer bilinmez: varsayılana döner.
          endpoint[keys.title] = before.seoTitle ?? "";
        } else {
          body.title = before.title ?? "";
        }
      }
      if (params.metaDescription !== null) {
        if (keys && ctx.fields.descriptionVia === "META") {
          meta[keys.description] = before.seoDescription ?? "";
        } else if (keys && ctx.fields.descriptionVia === "RANKMATH_ENDPOINT") {
          endpoint[keys.description] = before.seoDescription ?? "";
        }
      }
      if (Object.keys(meta).length) body.meta = meta;
      const endpointMeta = Object.keys(endpoint).length ? endpoint : null;
      if (body.title === undefined && !body.meta && !endpointMeta) {
        return cannot("There is nothing to restore with the current SEO plugin.");
      }
      return {
        ok: true,
        undo: {
          op: "restore",
          type: params.wpType,
          id: params.wpId,
          body,
          endpointMeta,
        },
      };
    }
  }
}

// Canlı nesne bizim yazdığımız hâlde mi (kullanıcı sonradan dokunmadı mı).
export function undoPrecondition(
  change: {
    kind: SeoChangeKind;
    status: SeoChangeStatus;
    after: WpSnapshot | null;
  },
  live: WpObject | null,
): boolean {
  if (!live) return false;
  switch (change.kind) {
    case "PUBLISH_ARTICLE":
      // Düzenlenmiş taslak asla çöpe atılmaz. after.modified, PUBLISH_LIVE
      // döngülerinde motor tarafından güncel tutulur.
      return (
        live.status === "draft" &&
        change.after !== null &&
        change.after.modified !== null &&
        live.modified === change.after.modified
      );
    case "PUBLISH_LIVE":
      return live.status === "publish";
    case "TITLE_META":
    case "INTERNAL_LINKS":
      // Yazısı inmiş ama sonrası bilinmeyen FAILED satırda denetim atlanır.
      if (change.after === null) return change.status === "FAILED";
      return change.after.modified !== null && live.modified === change.after.modified;
  }
}

// Geri almadan sonra canlı nesne beklenen hâlde mi.
export function verifyUndo(
  undo: UndoOp,
  live: WpObject | null,
  before: WpSnapshot | null,
): boolean {
  switch (undo.op) {
    case "trash":
      return live === null || live.status === "trash";
    case "unpublish":
      return live !== null && live.status === "draft";
    case "restore": {
      if (!live) return false;
      if (undo.body.title !== undefined && live.title !== undo.body.title) {
        return false;
      }
      if (undo.body.content !== undefined) {
        if (live.content === null) return false;
        const wanted = before?.contentHash ?? contentHashOf(undo.body.content);
        if (contentHashOf(live.content) !== wanted) return false;
      }
      // Yalnız REST'te görünen meta anahtarları denetlenir.
      for (const [key, value] of Object.entries(undo.body.meta ?? {})) {
        const read = live.meta[key];
        if (typeof read === "string" && read !== value) return false;
      }
      return true;
    }
  }
}
