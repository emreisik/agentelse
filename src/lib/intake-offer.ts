// What the tap on the creation screen's primary button starts, and what the
// screen says about it. ONE module decides both, so the promise and the action
// can never drift: the note names AI credit exactly when the tap really starts
// something that spends it.
//
// The offer is a fact of the server (is a real model configured, is the paid
// research open for this workspace); the screen only shows it. Nothing starts
// without a website address: there is nothing to read.

export type IntakeOffer = {
  // The website's logo, colours, fonts and style are read into the brand kit.
  scan: boolean;
  // The brand is researched on the web and a first draft of its profile saved.
  // Only ever offered together with the scan.
  research: boolean;
};

export const NO_OFFER: IntakeOffer = { scan: false, research: false };

export const CREATE_COPY = {
  idle: "Create and continue",
  scan: "Create and read my website",
  research: "Create and set up with AI",
  noteScan:
    "We'll read your website to find your logo, colors and fonts. This uses a little AI credit.",
  noteResearch:
    "We'll read your website and research your brand on the web, then save a first draft of your brand profile. This uses AI credit and can take a couple of minutes.",
  noteNoSite:
    "Add a website and we can also read your logo, colors and fonts.",
} as const;

// What the tap really starts.
export function intakeStartsOf(
  offer: IntakeOffer,
  hasWebsite: boolean,
): IntakeOffer {
  if (!hasWebsite) return NO_OFFER;
  return {
    scan: offer.scan || offer.research,
    research: offer.scan && offer.research,
  };
}

export type IntakeCopy = {
  button: string;
  // Null: nothing to say. A note that says "uses AI credit" appears only when
  // `spends` is true.
  note: string | null;
  spends: boolean;
};

export function intakeCopyFor(
  offer: IntakeOffer,
  hasWebsite: boolean,
): IntakeCopy {
  const starts = intakeStartsOf(offer, hasWebsite);
  if (starts.research) {
    return { button: CREATE_COPY.research, note: CREATE_COPY.noteResearch, spends: true };
  }
  if (starts.scan) {
    return { button: CREATE_COPY.scan, note: CREATE_COPY.noteScan, spends: true };
  }
  if (!hasWebsite && (offer.scan || offer.research)) {
    return { button: CREATE_COPY.idle, note: CREATE_COPY.noteNoSite, spends: false };
  }
  return { button: CREATE_COPY.idle, note: null, spends: false };
}
