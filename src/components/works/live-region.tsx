// Transient text INSIDE a card that stays mounted (a suggestion cycling).
// Always rendered, so assistive tech registers the change. Anything announced
// across a card replacement goes through the host's announce instead.
export function CardLiveRegion({ message }: { message: string | null }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}
