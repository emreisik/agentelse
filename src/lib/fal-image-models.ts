// Curated fal.ai image models offered in the Image Studio's model picker
// (see creative-image-studio.tsx). fal.ai hosts 50+ image-generation
// endpoints; listing them all would be unusable. This is a broader,
// named-by-use-case list — the trending/flagship model per family (FLUX,
// Seedream, Recraft, Ideogram) plus the editing/
// background-removal/upscaling specialists — not the full catalog. Adding
// another model later is a line here, not a code change (endpointId is the
// only thing fal-image-client.ts needs). Prices are approximate (fal's own
// pricing page is the source of truth) and shown in the picker so the user
// can make an informed choice.
export type FalImageModelCategory =
  | "Fast"
  | "Standard"
  | "Premium"
  | "Budget"
  | "Typography"
  | "Editing"
  | "Background removal"
  | "Upscale";

export type FalImageModel = {
  id: string;
  label: string;
  endpointId: string;
  category: FalImageModelCategory;
  approxPrice: string;
  // Whether this endpoint accepts an input image (edit/image-to-image) —
  // gates which models the Studio offers in "edit this image" mode. See
  // creative-image.ts's edit-mode handling.
  supportsImageInput: boolean;
};

export const FAL_IMAGE_MODELS: FalImageModel[] = [
  {
    id: "flux-schnell",
    label: "FLUX Schnell",
    endpointId: "fal-ai/flux/schnell",
    category: "Fast",
    approxPrice: "$0.003/img",
    supportsImageInput: false,
  },
  {
    id: "flux-dev",
    label: "FLUX Dev",
    endpointId: "fal-ai/flux/dev",
    category: "Standard",
    approxPrice: "$0.025/img",
    supportsImageInput: false,
  },
  {
    id: "flux-pro-ultra",
    label: "FLUX Pro 1.1 Ultra",
    endpointId: "fal-ai/flux-pro/v1.1-ultra",
    category: "Premium",
    approxPrice: "$0.06/img",
    supportsImageInput: false,
  },
  {
    id: "flux-2-pro",
    label: "FLUX.2 Pro",
    endpointId: "fal-ai/flux-2-pro",
    category: "Premium",
    approxPrice: "$0.03+/img",
    supportsImageInput: false,
  },
  {
    id: "qwen-image",
    label: "Qwen Image",
    endpointId: "fal-ai/qwen-image",
    category: "Budget",
    approxPrice: "$0.02/mp",
    supportsImageInput: false,
  },
  {
    id: "seedream-v4",
    label: "Seedream V4",
    endpointId: "bytedance/seedream/v4",
    category: "Standard",
    approxPrice: "$0.03/img",
    supportsImageInput: false,
  },
  {
    id: "imagen3",
    label: "Google Imagen 3",
    endpointId: "fal-ai/imagen3",
    category: "Premium",
    approxPrice: "$0.05/img",
    supportsImageInput: false,
  },
  {
    id: "imagen3-fast",
    label: "Google Imagen 3 Fast",
    endpointId: "fal-ai/imagen3/fast",
    category: "Standard",
    approxPrice: "$0.025/img",
    supportsImageInput: false,
  },
  {
    id: "recraft-v3",
    label: "Recraft V3",
    endpointId: "fal-ai/recraft/v3/text-to-image",
    category: "Typography",
    approxPrice: "$0.04/img",
    supportsImageInput: false,
  },
  {
    id: "ideogram-v3",
    label: "Ideogram V3",
    endpointId: "fal-ai/ideogram/v3",
    category: "Typography",
    approxPrice: "$0.03-0.09/img",
    supportsImageInput: false,
  },
  {
    id: "flux-kontext-pro",
    label: "FLUX Kontext Pro",
    endpointId: "fal-ai/flux-pro/kontext",
    category: "Editing",
    approxPrice: "$0.04/img",
    supportsImageInput: true,
  },
  {
    id: "flux-pro-fill",
    label: "FLUX Pro Fill (inpaint)",
    endpointId: "fal-ai/flux-pro/v1/fill",
    category: "Editing",
    approxPrice: "$0.05/mp",
    supportsImageInput: true,
  },
  {
    id: "bria-bg-remove",
    label: "Bria Background Remove",
    endpointId: "fal-ai/bria/background/remove",
    category: "Background removal",
    approxPrice: "$0.018/img",
    supportsImageInput: true,
  },
  {
    id: "clarity-upscaler",
    label: "Clarity Upscaler",
    endpointId: "fal-ai/clarity-upscaler",
    category: "Upscale",
    approxPrice: "compute-billed",
    supportsImageInput: true,
  },
];

export function findFalImageModel(id: string): FalImageModel | undefined {
  return FAL_IMAGE_MODELS.find((model) => model.id === id);
}
