// One post, one picture (docs/works.md "Shared picture"): the pieces of one
// post (its Instagram post, Facebook post, Instagram Story...) never get a
// picture each. The post's first image piece is rendered; every other image
// piece of the post is that same picture adapted to its own format. Pure:
// plan-run.ts decides with it which piece of a production run does what.

export type PictureSlot = {
  id: string;
  // The post it belongs to (postKeyOf of its plan item).
  post: string;
  // Its piece is a picture (image production).
  image: boolean;
  // Can be made now (no content yet, or a failed try).
  producible: boolean;
  // Being made right now by another run.
  producing: boolean;
  // Its current picture, once made.
  assetId?: string;
};

export type PictureSource =
  // Makes the post's picture (or is not a picture at all).
  | { kind: "render" }
  // Adapts the picture its post's lead makes in this same run.
  | { kind: "wait"; leadId: string }
  // Adapts the picture its post's lead already has.
  | { kind: "adapt"; assetId: string }
  // Its lead is being made by another run: this piece waits for the next one.
  | { kind: "skip" };

// The post's lead: its first image piece, in the plan's order.
function leadsOf(slots: readonly PictureSlot[]): Map<string, PictureSlot> {
  const leads = new Map<string, PictureSlot>();
  for (const slot of slots) {
    if (slot.image && !leads.has(slot.post)) leads.set(slot.post, slot);
  }
  return leads;
}

// A batch holds whole posts: a post with one piece in it brings its other
// pieces that can be made now (they share one picture), in the plan's order.
export function wholePosts(
  batch: readonly string[],
  slots: readonly PictureSlot[],
): string[] {
  const chosen = new Set(batch);
  const posts = new Set(
    slots.flatMap((slot) => (chosen.has(slot.id) ? [slot.post] : [])),
  );
  const added = slots.filter(
    (slot) => posts.has(slot.post) && slot.producible && !chosen.has(slot.id),
  );
  return [...batch, ...added.map((slot) => slot.id)];
}

// The leads outside the batch whose picture a piece of the batch would adapt:
// the only pictures worth looking up.
export function leadsToLookUp(
  batch: readonly string[],
  slots: readonly PictureSlot[],
): string[] {
  const inBatch = new Set(batch);
  const leads = leadsOf(slots);
  const wanted = new Set<string>();
  for (const slot of slots) {
    const lead = leads.get(slot.post);
    if (
      inBatch.has(slot.id) &&
      lead &&
      lead.id !== slot.id &&
      slot.image &&
      !inBatch.has(lead.id) &&
      !lead.producing
    ) {
      wanted.add(lead.id);
    }
  }
  return [...wanted];
}

// At most `max` posts per run (each costs one paid picture), in the batch's
// order; a post is never split.
export function capPosts(
  batch: readonly string[],
  slots: readonly PictureSlot[],
  max: number,
): string[] {
  const postOf = new Map(slots.map((slot) => [slot.id, slot.post]));
  const kept = new Set<string>();
  return batch.filter((id) => {
    const post = postOf.get(id) ?? id;
    if (kept.has(post)) return true;
    if (kept.size >= max) return false;
    kept.add(post);
    return true;
  });
}

// Where each piece of the batch gets its picture. `postPictures`: the picture a
// post already has (Post.pictureAssetId, by post): every image piece of that
// post adapts it, whichever piece drew it.
export function pictureSources(
  batch: readonly string[],
  slots: readonly PictureSlot[],
  postPictures: ReadonlyMap<string, string> = new Map(),
): Map<string, PictureSource> {
  const inBatch = new Set(batch);
  const leads = leadsOf(slots);
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const sources = new Map<string, PictureSource>();
  for (const id of batch) {
    const slot = byId.get(id);
    const picture = slot?.image ? postPictures.get(slot.post) : undefined;
    const lead = slot?.image ? leads.get(slot.post) : undefined;
    if (picture) {
      sources.set(id, { kind: "adapt", assetId: picture });
    } else if (!slot || !lead || lead.id === id) {
      sources.set(id, { kind: "render" });
    } else if (inBatch.has(lead.id)) {
      sources.set(id, { kind: "wait", leadId: lead.id });
    } else if (lead.producing) {
      sources.set(id, { kind: "skip" });
    } else if (lead.assetId) {
      sources.set(id, { kind: "adapt", assetId: lead.assetId });
    } else {
      // A lead made without a picture: nothing to adapt, this one makes its own.
      sources.set(id, { kind: "render" });
    }
  }
  return sources;
}
