/**
 * Client-side reader for the `droppedTagKeys` / `droppedFactorKeys` fields a
 * mood write answers with (see `src/lib/mood/tag-links.ts`). Each list is
 * present only when the server did not store some of the submitted keys —
 * a tag archived in another tab, a custom tag deleted on another device —
 * so its presence alone is the signal; the client re-derives nothing.
 */
export interface DroppedLinkKeysWire {
  droppedTagKeys?: string[];
  droppedFactorKeys?: string[];
}

export function droppedAnyLinkKeys(
  response: DroppedLinkKeysWire | null | undefined,
): boolean {
  return (
    (response?.droppedTagKeys?.length ?? 0) > 0 ||
    (response?.droppedFactorKeys?.length ?? 0) > 0
  );
}
