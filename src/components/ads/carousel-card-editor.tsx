"use client";

import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { ImagePlus, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import type { FormValues } from "@/components/ads/adset-ad-wizard";
import { useObjectUrl } from "@/lib/use-object-url";

const MIN_CARDS = 2;
const MAX_CARDS = 10;

// react-hook-form's dynamic-array primitive — not used anywhere else in
// this codebase yet (see meta-ads-wizard-faz456-research), but it's the
// standard fit for "add/remove N cards" and composes with the rest of the
// wizard's single shared useForm the same way every other step's fields do.
// Card TEXT fields (link/name/description) live in the form under
// `ad.cards`; each card's IMAGE is kept as a parallel plain File array
// (`images`) outside the form — same reasoning as the single-image step's
// local `image` state: a File isn't meaningfully validated by zod the way
// text fields are, and keeping it out of react-hook-form avoids re-render
// churn on every keystroke elsewhere in the form.
export function CarouselCardEditor({
  form,
  images,
  onImagesChange,
  imagesError,
}: {
  form: UseFormReturn<FormValues>;
  images: (File | null)[];
  onImagesChange: (images: (File | null)[]) => void;
  imagesError: string | null;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "ad.cards",
  });

  function addCard() {
    if (fields.length >= MAX_CARDS) return;
    append({ link: "", name: "", description: "" });
    onImagesChange([...images, null]);
  }

  function removeCard(index: number) {
    if (fields.length <= MIN_CARDS) return;
    remove(index);
    onImagesChange(images.filter((_, i) => i !== index));
  }

  function setCardImage(index: number, file: File | null) {
    const next = [...images];
    next[index] = file;
    onImagesChange(next);
  }

  return (
    <div className="space-y-3">
      {fields.map((field, index) => (
        <CarouselCardRow
          key={field.id}
          form={form}
          index={index}
          image={images[index] ?? null}
          onImageChange={(file) => setCardImage(index, file)}
          removable={fields.length > MIN_CARDS}
          onRemove={() => removeCard(index)}
        />
      ))}
      {imagesError ? (
        <p className="text-sm text-destructive">{imagesError}</p>
      ) : null}
      {fields.length < MAX_CARDS ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addCard}
          className="w-full"
        >
          <Plus /> Add card
        </Button>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {fields.length} of {MAX_CARDS} cards ({MIN_CARDS} minimum)
      </p>
    </div>
  );
}

// Its own component (not inlined in the .map() above) so useObjectUrl — a
// hook — can be called once per card, satisfying the rules of hooks; a
// bare .map() callback isn't a component and can't call hooks itself.
function CarouselCardRow({
  form,
  index,
  image,
  onImageChange,
  removable,
  onRemove,
}: {
  form: UseFormReturn<FormValues>;
  index: number;
  image: File | null;
  onImageChange: (file: File | null) => void;
  removable: boolean;
  onRemove: () => void;
}) {
  const imagePreviewUrl = useObjectUrl(image);
  return (
    <div className="space-y-2.5 rounded-xl bg-muted/30 p-3 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Card {index + 1}
        </span>
        {removable ? (
          <button
            type="button"
            onClick={onRemove}
            className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Remove card ${index + 1}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex items-start gap-3">
        <label className="flex size-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground ring-1 ring-foreground/10">
          {imagePreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imagePreviewUrl}
              alt=""
              className="size-full object-cover"
            />
          ) : (
            <ImagePlus className="size-4" />
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => onImageChange(event.target.files?.[0] ?? null)}
            className="hidden"
          />
        </label>
        <div className="min-w-0 flex-1 space-y-2">
          <FormField
            control={form.control}
            name={`ad.cards.${index}.name`}
            render={({ field: f }) => (
              <FormItem>
                <FormControl>
                  <Input {...f} placeholder="Headline" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name={`ad.cards.${index}.link`}
            render={({ field: f }) => (
              <FormItem>
                <FormControl>
                  <Input
                    {...f}
                    type="url"
                    placeholder="https://example.com/item"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>
    </div>
  );
}
