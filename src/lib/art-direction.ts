import { z } from "zod";

// The art director's answer: a post's picture worked out as a photographer or
// illustrator would brief it, one field per decision, so the picture is
// specific to the brand and the idea instead of a generic "nice image of X".
// The fields are assembled into the scene the image model is told to make.
// Pure and client-safe.

const field = (max: number) => z.string().trim().min(1).max(max);

export const ArtDirectionSchema = z.object({
  // The visual idea in one sentence: what the picture says about the message.
  concept: field(240),
  // Exactly what is in the picture: nouns, count, materials, colours, action.
  subject: field(420),
  // Where it is: the place, the background, what surrounds the subject.
  setting: field(320),
  // Framing, angle, depth, and where the subject sits against the calm area.
  composition: field(320),
  // Light source, direction, quality, colour temperature, time of day.
  lighting: field(260),
  // Camera and lens for a photograph; medium and method for an illustration.
  technique: field(260),
  // Tactile detail and honest imperfection that make it read as real.
  texture: field(260),
  mood: field(140),
  // What would spoil THIS picture, specific to the brand and the idea.
  avoid: z.array(field(120)).max(6).default([]),
  // Complete, self-contained alternative scene briefs, each with its own
  // composition and light (only when more than one picture is made).
  alternatives: z.array(field(700)).max(4).optional(),
});
export type ArtDirection = z.infer<typeof ArtDirectionSchema>;

const sentence = (value: string) => {
  const trimmed = value.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
};

// The scene, in the order an image model weighs it: what, where, how it is
// framed, lit and shot, how it feels.
export function assembleScene(direction: ArtDirection): string {
  return [
    sentence(direction.subject),
    `Setting: ${sentence(direction.setting)}`,
    `Composition: ${sentence(direction.composition)}`,
    `Lighting: ${sentence(direction.lighting)}`,
    `Technique: ${sentence(direction.technique)}`,
    `Texture and detail: ${sentence(direction.texture)}`,
    `Mood: ${sentence(direction.mood)}`,
  ].join(" ");
}

// The director's own list of what to keep out, to join the brand's.
export function directionAvoid(direction: ArtDirection): string | undefined {
  const items = direction.avoid.map((item) => item.replace(/[.\s]+$/u, ""));
  return items.length > 0 ? items.join("; ") : undefined;
}
