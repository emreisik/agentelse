// Curated fal.ai image models offered in the Image Studio's model picker
// (see creative-image-studio.tsx). fal.ai hosts 50+ image-generation
// endpoints; listing them all would be unusable. This is a small,
// named-by-use-case list instead — adding another model later is a line
// here, not a code change (endpointId is the only thing fal-image-client.ts
// needs). Prices are approximate (fal's own pricing page is the source of
// truth) and shown in the picker so the user can make an informed choice —
// video models are an order of magnitude more expensive than these, which
// is exactly why this integration is image-only for now.
export type FalImageModel = {
  id: string;
  label: string;
  endpointId: string;
  category:
    | "fast"
    | "standard"
    | "premium"
    | "typography"
    | "editing"
    | "background-removal"
    | "upscaling";
  approxPrice: string;
  // Whether this endpoint accepts an input image (edit/image-to-image) —
  // gates which models the Studio offers in "edit this image" mode. See
  // creative-image.ts's edit-mode handling.
  supportsImageInput: boolean;
};

export const FAL_IMAGE_MODELS: FalImageModel[] = [
  {
    id: "flux-schnell",
    label: "FLUX Schnell (fast draft)",
    endpointId: "fal-ai/flux/schnell",
    category: "fast",
    approxPrice: "~$0.003/image",
    supportsImageInput: false,
  },
  {
    id: "flux-dev",
    label: "FLUX Dev (standard)",
    endpointId: "fal-ai/flux/dev",
    category: "standard",
    approxPrice: "~$0.025/image",
    supportsImageInput: false,
  },
  {
    id: "flux-pro-ultra",
    label: "FLUX Pro 1.1 Ultra (premium/hero)",
    endpointId: "fal-ai/flux-pro/v1.1-ultra",
    category: "premium",
    approxPrice: "~$0.06/image",
    supportsImageInput: false,
  },
  {
    id: "recraft-v3",
    label: "Recraft V3 (vector, typography, brand graphics)",
    endpointId: "fal-ai/recraft/v3/text-to-image",
    category: "typography",
    approxPrice: "~$0.04/image",
    supportsImageInput: false,
  },
  {
    id: "ideogram-v3",
    label: "Ideogram V3 (posters, readable in-image text)",
    endpointId: "fal-ai/ideogram/v3",
    category: "typography",
    approxPrice: "~$0.03-0.09/image",
    supportsImageInput: false,
  },
  {
    id: "flux-kontext-pro",
    label: "FLUX Kontext Pro (instruction-based editing)",
    endpointId: "fal-ai/flux-pro/kontext",
    category: "editing",
    approxPrice: "~$0.04/image",
    supportsImageInput: true,
  },
  {
    id: "bria-bg-remove",
    label: "Bria Background Remove (product cutouts)",
    endpointId: "fal-ai/bria/background/remove",
    category: "background-removal",
    approxPrice: "~$0.018/image",
    supportsImageInput: true,
  },
  {
    id: "clarity-upscaler",
    label: "Clarity Upscaler (add detail while upscaling)",
    endpointId: "fal-ai/clarity-upscaler",
    category: "upscaling",
    approxPrice: "compute-time billed",
    supportsImageInput: true,
  },
];

export function findFalImageModel(id: string): FalImageModel | undefined {
  return FAL_IMAGE_MODELS.find((model) => model.id === id);
}
