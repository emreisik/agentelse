import "server-only";

import {
  pickReferenceExamples,
  postStyleSection,
  type PostStyleContext,
} from "@/lib/post-style";
import { loadReferenceImage } from "@/server/media/brand-logo";

// The pictures a render is given to follow, and the words that tell the model
// what each one is: the brand's example posts first, then the real product of
// this post. A brand with no Post Style Kit keeps the one "style board" picture
// it always could have (and its old wording).

export type StyleReferences = {
  // In the order the prompt names them.
  images: { data: string; mimeType: string }[];
  exampleCount: number;
  productCount: number;
  // The prompt section for them; null when there is nothing to say.
  section: string | null;
  // The kit asks for posts that follow its examples closely.
  matchStyle: boolean;
  // The old single style board is the (first) picture, with its old wording.
  legacyBoard: boolean;
};

const MAX_PRODUCT_IMAGES = 3;

export const NO_STYLE_REFERENCES: StyleReferences = {
  images: [],
  exampleCount: 0,
  productCount: 0,
  section: null,
  matchStyle: false,
  legacyBoard: false,
};

export async function loadStyleReferences(input: {
  visualIdentity:
    | {
        postStyle?: PostStyleContext | null;
        referenceImageAssetId?: string | null;
      }
    | null
    | undefined;
  // The examples the agent chose for this post (else the newest).
  exampleIds?: readonly string[];
  // The real product's pictures (Assets of the project).
  productAssetIds?: readonly string[];
  // False when the render edits a picture: it has one input only.
  withReferences?: boolean;
  // The post's project: every picture is looked up inside it.
  projectId?: string;
}): Promise<StyleReferences> {
  if (input.withReferences === false) return NO_STYLE_REFERENCES;
  const kit = input.visualIdentity?.postStyle ?? null;

  const picked = pickReferenceExamples(kit, input.exampleIds);
  const loaded = await Promise.all(
    picked.map(async (example) => ({
      example,
      image: await loadReferenceImage(example.assetId, input.projectId),
    })),
  );
  const examples = loaded.flatMap((entry) =>
    entry.image ? [{ example: entry.example, image: entry.image }] : [],
  );

  const products = (
    await Promise.all(
      (input.productAssetIds ?? [])
        .slice(0, MAX_PRODUCT_IMAGES)
        .map((assetId) => loadReferenceImage(assetId, input.projectId)),
    )
  ).flatMap((image) => (image ? [image] : []));

  let board: { data: string; mimeType: string } | null = null;
  if (examples.length === 0) {
    board = await loadReferenceImage(
      input.visualIdentity?.referenceImageAssetId ?? undefined,
      input.projectId,
    );
  }

  const images = [
    ...examples.map((entry) => entry.image),
    ...(board ? [board] : []),
    ...products,
  ];
  const section = postStyleSection({
    context: kit,
    examples: examples.map((entry) => entry.example),
    referenceCount: examples.length,
    productCount: products.length,
  });
  return {
    images,
    exampleCount: examples.length,
    productCount: products.length,
    section,
    matchStyle: kit?.fidelity === "match" && examples.length > 0,
    legacyBoard: board !== null,
  };
}
