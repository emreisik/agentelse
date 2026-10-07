// SC-F8: bir değişikliğin canlı nesneye göre planı (saf). Motor canlı nesneyi okur,
// planChange ne yazılacağına karar verir; yazmayı ve geri okumayı motor yapar.
// Yeniden deneme kuralları (docs/search-actions.md SC-F8, "RETRY / ADOPTION"):
//  - İlk denemede ctx.prior = null; sonraki denemelerde ilk claim'de saklanan before.
//  - TITLE_META / INTERNAL_LINKS sırası: canlı yok -> page_not_found; hedef zaten
//    sağlanmış -> noop (prior varsa ve prior sağlamıyorsa landedEarlier: zaman aşımına
//    uğrayan ilk yazma gerçekten inmiş); bayat denetimi (taban: prior ? prior.modified :
//    expectModified) -> farklıysa yalnız çok yazmalı TITLE_META'da ilk yazma inmişse
//    kalan yazmalarla devam (resumed), yoksa page_changed; desteklenmeyen açıklama ->
//    seo_plugin_unsupported; yetki; yaz.
//  - PUBLISH_ARTICLE her zaman taslak ('draft' sabit); benimsenen taslak = noop.
// Yalnız sunucu tarafı: crawl-url'e (node:crypto) dayanan dosyaları içe aktarır.

import type {
  SeoChangeErrorCode,
  SeoChangeParams,
  SeoFieldsCapability,
  WpCapabilities,
  WpSnapshot,
  WpType,
} from "../types";
import { titleForPost } from "../validate";
import { markdownToBlocks } from "./blocks";
import { capabilityAllows } from "./capabilities";
import { insertInternalLinks, linksPresent } from "./internal-links";
import { seoValuesOf, seoWritePlan } from "./plugin-fields";
import { contentHashOf, snapshotOf, textHashOf } from "./snapshot";
import type { WpObject } from "./wp-types";

export type WpWrite =
  | {
      op: "create";
      type: "post";
      body: {
        title: string;
        status: "draft";
        content: string;
        excerpt: string;
        meta?: Record<string, string>;
      };
    }
  | {
      op: "update";
      type: WpType;
      id: number;
      body: {
        title?: string;
        status?: "draft" | "publish";
        content?: string;
        excerpt?: string;
        meta?: Record<string, string>;
      };
    }
  | { op: "rankMathMeta"; id: number; meta: Record<string, string> };

export type ExpectedAfter = {
  status?: string;
  title?: string;
  textHash?: string;
  contentHash?: string;
  seoTitle?: string;
  seoDescription?: string;
  excerpt?: string;
};

export type ChangePlan =
  | { kind: "noop"; snapshot: WpSnapshot; landedEarlier: boolean }
  | {
      kind: "write";
      before: WpSnapshot;
      writes: WpWrite[];
      expectAfter: ExpectedAfter;
      resumed: boolean;
    }
  | { kind: "refuse"; code: SeoChangeErrorCode };

export type PlanContext = {
  fields: SeoFieldsCapability;
  capabilities: WpCapabilities;
  // İlk denemede saklanan before; ilk denemede null.
  prior: WpSnapshot | null;
};

const EXCERPT_MAX = 300;

function refuse(code: SeoChangeErrorCode): ChangePlan {
  return { kind: "refuse", code };
}

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("").trim();
}

// ---- PUBLISH_ARTICLE ----------------------------------------------------------

function planArticle(
  params: Extract<SeoChangeParams, { kind: "PUBLISH_ARTICLE" }>,
  live: WpObject | null,
  ctx: PlanContext,
): ChangePlan {
  // Benimsenen taslak: önceki (zaman aşımına uğramış) POST gerçekten yazmıştı.
  if (live) {
    return {
      kind: "noop",
      snapshot: snapshotOf(live, ctx.fields, { withContentRaw: false }),
      landedEarlier: true,
    };
  }
  if (!capabilityAllows(ctx.capabilities, "PUBLISH_ARTICLE", "post")) {
    return refuse("no_permission");
  }

  const title = titleForPost(params.title);
  const { content } = markdownToBlocks(params.markdown, { title: params.title });
  const excerpt = cut(params.metaDescription, EXCERPT_MAX);
  // Yeni taslakta yalnız meta açıklama yazılır (başlık yazı başlığından gelir);
  // Rank Math uç noktası yazının kimliği olmadan çağrılamaz, açıklama özet olarak kalır.
  const seo = seoWritePlan(ctx.fields, {
    title: null,
    description: params.metaDescription,
  });
  const hasMeta = Object.keys(seo.meta).length > 0;

  const expectAfter: ExpectedAfter = {
    status: "draft",
    title,
    textHash: textHashOf(content),
    excerpt,
  };
  if (hasMeta) expectAfter.seoDescription = params.metaDescription;

  return {
    kind: "write",
    before: snapshotOf(null, ctx.fields, { withContentRaw: false }),
    writes: [
      {
        op: "create",
        type: "post",
        body: {
          title,
          status: "draft",
          content,
          excerpt,
          ...(hasMeta ? { meta: seo.meta } : {}),
        },
      },
    ],
    expectAfter,
    resumed: false,
  };
}

// ---- PUBLISH_LIVE -------------------------------------------------------------

function planLive(
  params: Extract<SeoChangeParams, { kind: "PUBLISH_LIVE" }>,
  live: WpObject | null,
  ctx: PlanContext,
): ChangePlan {
  if (!live) return refuse("page_not_found");
  const snapshot = snapshotOf(live, ctx.fields, { withContentRaw: false });
  if (live.status === "publish") {
    return {
      kind: "noop",
      snapshot,
      landedEarlier: Boolean(ctx.prior && ctx.prior.status !== "publish"),
    };
  }
  const baseline = ctx.prior ? ctx.prior.modified : params.expectModified;
  if (live.modified !== baseline) return refuse("page_changed");
  if (!["draft", "pending", "future", "private"].includes(live.status)) {
    return refuse("rejected_by_site");
  }
  if (!capabilityAllows(ctx.capabilities, "PUBLISH_LIVE", "post")) {
    return refuse("no_permission");
  }
  return {
    kind: "write",
    before: ctx.prior ?? snapshot,
    writes: [
      { op: "update", type: "post", id: params.wpId, body: { status: "publish" } },
    ],
    expectAfter: { status: "publish" },
    resumed: false,
  };
}

// ---- TITLE_META ---------------------------------------------------------------

type FieldView = {
  title: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

function planTitleMeta(
  params: Extract<SeoChangeParams, { kind: "TITLE_META" }>,
  live: WpObject | null,
  ctx: PlanContext,
): ChangePlan {
  if (!live) return refuse("page_not_found");
  const { fields } = ctx;
  const seo = seoWritePlan(fields, {
    title: params.title,
    description: params.metaDescription,
  });

  // Hangi alanın hangi yoldan yazılacağı (okunabilir olanlar karşılaştırılır).
  const coreWanted = params.title !== null && fields.titleVia === "POST_TITLE";
  const titleMetaWanted = params.title !== null && fields.titleVia === "META";
  const descMetaWanted =
    params.metaDescription !== null && fields.descriptionVia === "META";
  const updateBody: {
    title?: string;
    meta?: Record<string, string>;
  } = {};
  if (seo.coreTitle !== null) updateBody.title = seo.coreTitle;
  if (Object.keys(seo.meta).length) updateBody.meta = seo.meta;
  const hasUpdate = Object.keys(updateBody).length > 0;

  let writes: WpWrite[] = [];
  if (hasUpdate) {
    writes.push({
      op: "update",
      type: params.wpType,
      id: params.wpId,
      body: updateBody,
    });
  }
  if (seo.endpointMeta) {
    writes.push({ op: "rankMathMeta", id: params.wpId, meta: seo.endpointMeta });
  }

  const updateSatisfiedBy = (view: FieldView): boolean =>
    (!coreWanted || view.title === params.title) &&
    (!titleMetaWanted || view.seoTitle === params.title) &&
    (!descMetaWanted || view.seoDescription === params.metaDescription);
  // Uç nokta alanları geri okunamaz: onlar varsa "zaten sağlanmış" denemez.
  const satisfiedBy = (view: FieldView): boolean =>
    !seo.unsupported &&
    hasUpdate &&
    seo.endpointMeta === null &&
    updateSatisfiedBy(view);

  const liveView: FieldView = {
    title: live.title,
    ...seoValuesOf(fields, live.meta),
  };

  if (satisfiedBy(liveView)) {
    const priorSatisfied =
      ctx.prior !== null &&
      satisfiedBy({
        title: ctx.prior.title,
        seoTitle: ctx.prior.seoTitle,
        seoDescription: ctx.prior.seoDescription,
      });
    return {
      kind: "noop",
      snapshot: snapshotOf(live, fields, { withContentRaw: false }),
      landedEarlier: ctx.prior !== null && !priorSatisfied,
    };
  }

  let resumed = false;
  const baseline = ctx.prior ? ctx.prior.modified : params.expectModified;
  if (live.modified !== baseline) {
    // Önceki deneme ilk yazmayı indirdiyse yalnız kalanı gönderilir.
    const resumable =
      ctx.prior !== null &&
      !seo.unsupported &&
      hasUpdate &&
      writes.length >= 2 &&
      updateSatisfiedBy(liveView);
    if (!resumable) return refuse("page_changed");
    writes = writes.slice(1);
    resumed = true;
  }

  if (seo.unsupported) return refuse("seo_plugin_unsupported");
  if (!writes.length) return refuse("unknown");
  if (!capabilityAllows(ctx.capabilities, "TITLE_META", params.wpType)) {
    return refuse("no_permission");
  }

  const expectAfter: ExpectedAfter = {};
  if (coreWanted && params.title !== null) expectAfter.title = params.title;
  if (titleMetaWanted && params.title !== null) {
    expectAfter.seoTitle = params.title;
  }
  if (descMetaWanted && params.metaDescription !== null) {
    expectAfter.seoDescription = params.metaDescription;
  }

  return {
    kind: "write",
    before:
      ctx.prior ?? snapshotOf(live, fields, { withContentRaw: false }),
    writes,
    expectAfter,
    resumed,
  };
}

// ---- INTERNAL_LINKS -----------------------------------------------------------

function planLinks(
  params: Extract<SeoChangeParams, { kind: "INTERNAL_LINKS" }>,
  live: WpObject | null,
  ctx: PlanContext,
): ChangePlan {
  if (!live) return refuse("page_not_found");

  if (live.content !== null && linksPresent(live.content, params.links)) {
    // Önceki saklanan görüntü bağlantıları zaten içeriyorsa biz yazmadık.
    const priorSatisfied =
      ctx.prior !== null &&
      ctx.prior.contentRaw !== null &&
      linksPresent(ctx.prior.contentRaw, params.links);
    return {
      kind: "noop",
      snapshot: snapshotOf(live, ctx.fields, { withContentRaw: true }),
      landedEarlier: ctx.prior !== null && !priorSatisfied,
    };
  }

  const baseline = ctx.prior ? ctx.prior.modified : params.expectModified;
  if (live.modified !== baseline) return refuse("page_changed");

  // İçerik okunamıyorsa (korumalı) ya da boşsa güvenle düzenlenemez.
  if (live.content === null) return refuse("builder_page");
  const result = insertInternalLinks(live.content, params.links);
  if (!result.ok) {
    return refuse(
      result.code === "anchor_not_found" ? "anchor_not_found" : "builder_page",
    );
  }
  if (!capabilityAllows(ctx.capabilities, "INTERNAL_LINKS", params.wpType)) {
    return refuse("no_permission");
  }

  return {
    kind: "write",
    before:
      ctx.prior ?? snapshotOf(live, ctx.fields, { withContentRaw: true }),
    writes: [
      {
        op: "update",
        type: params.wpType,
        id: params.wpId,
        body: { content: result.raw },
      },
    ],
    expectAfter: { contentHash: contentHashOf(result.raw) },
    resumed: false,
  };
}

export function planChange(
  params: SeoChangeParams,
  live: WpObject | null,
  ctx: PlanContext,
): ChangePlan {
  switch (params.kind) {
    case "PUBLISH_ARTICLE":
      return planArticle(params, live, ctx);
    case "PUBLISH_LIVE":
      return planLive(params, live, ctx);
    case "TITLE_META":
      return planTitleMeta(params, live, ctx);
    case "INTERNAL_LINKS":
      return planLinks(params, live, ctx);
  }
}
