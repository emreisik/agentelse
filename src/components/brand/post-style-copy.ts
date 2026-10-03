// Every sentence of the Brand Brain's Post style card.
export const POST_STYLE_COPY = {
  title: "Post style",
  intro:
    "Example posts your brand's posts are designed like. Every post follows them (layout, typography, graphics, look); only the product and the words change.",
  exampleCount: (n: number) => `${n} ${n === 1 ? "example" : "examples"}`,
  noExamples: "No examples yet. Add the posts you want your design to follow.",
  on: "On",
  off: "Off",
  switchAria: (name: string) => `Use ${name} for new posts`,
  untitled: "Example post",
  labelAria: "Name of the example",
  notRead: "Not read yet",
  reread: "Read again",
  remove: "Remove",
  details: "How it is built",
  hideDetails: "Hide",
  fromLink: "From a link",
  fromChat: "From the chat",
  fromLiked: "A post you liked",
  addTitle: "Add examples",
  choosePictures: "Choose pictures",
  picturesChosen: (n: number) => `${n} ${n === 1 ? "picture" : "pictures"} chosen`,
  linksLabel: "Links (one per line)",
  linksPlaceholder: "https://example.com/post-picture.jpg",
  linksHint:
    "A link to a picture, or to a page that shows it. Instagram and other networks don't hand other accounts' pictures to apps: save the picture or take a screenshot and choose it as a file.",
  addButton: "Add examples",
  adding: "Reading your examples…",
  addingHint: "Each example is taken apart into a design recipe; this takes a few seconds per picture.",
  limit: (n: number) => `Up to ${n} at a time.`,
  nothingToAdd: "Choose a picture or paste a link.",
  addedSummary: (added: number, failed: number) =>
    failed > 0
      ? `${added} added, ${failed} could not be.`
      : `${added} added.`,
  fidelityLabel: "How closely posts follow the examples",
  fidelityMatch: "Follow closely",
  fidelityInspired: "Use as direction",
  fidelityHintMatch:
    "New posts recreate the examples' design as faithfully as possible.",
  fidelityHintInspired:
    "New posts take the examples as direction and may adapt the composition.",
  directivesTitle: "Always apply",
  directivesHint:
    "Standing instructions for every post. They override any other taste.",
  directivesPlaceholder:
    "For example: Posts are product-focused. The real product is the hero, large and centred, on a dark gradient. One bold headline at the top, a purple button at the bottom.",
  save: "Save",
  saved: "Saved",
  chars: (used: number, max: number) => `${used}/${max}`,
  failed: "That didn't work. Try again.",
} as const;
