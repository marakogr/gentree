// Pure media helpers shared by the person card and the ancestor graph. No DOM,
// no IPC: everything here is deterministic and unit-testable.

import type { MediaItem } from "../../api/types";

export type MediaKind = "image" | "document";

/** `isImage` is authoritative; the MIME prefix is a defensive fallback. */
export function isImageMedia(
  item: Pick<MediaItem, "isImage" | "mimeType">,
): boolean {
  return item.isImage || /^image\//i.test(item.mimeType);
}

export function mediaKind(item: MediaItem): MediaKind {
  return isImageMedia(item) ? "image" : "document";
}

/** Caption when present, otherwise the stored file name. */
export function mediaLabel(item: MediaItem): string {
  const caption = item.caption?.trim() ?? "";
  return caption === "" ? item.fileName : caption;
}

function compareText(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasCaption(item: MediaItem): boolean {
  return (item.caption?.trim() ?? "") !== "";
}

/**
 * Deterministic photo order: captioned images first, then file name, then id.
 * The caption carries the person's own annotation, so it wins over a plain
 * scan without relying on the backend's ordering.
 */
function comparePhotos(left: MediaItem, right: MediaItem): number {
  if (hasCaption(left) !== hasCaption(right)) {
    return hasCaption(left) ? -1 : 1;
  }
  return (
    compareText(left.fileName, right.fileName) ||
    compareText(left.id, right.id)
  );
}

/**
 * First image of a person; documents and other people's media are ignored.
 * An image explicitly marked as the profile photo wins; otherwise the
 * deterministic caption/file-name order picks one.
 */
export function primaryPhoto(
  items: readonly MediaItem[],
): MediaItem | null {
  const images = items.filter(isImageMedia);
  if (images.length === 0) return null;
  const marked = images.filter((item) => item.primary);
  if (marked.length > 0) return [...marked].sort(comparePhotos)[0] ?? null;
  return [...images].sort(comparePhotos)[0] ?? null;
}

/** One deterministic primary photo per person, for the ancestor tree. */
export function photosByPerson(
  items: readonly MediaItem[],
): Map<string, MediaItem> {
  const grouped = new Map<string, MediaItem[]>();
  for (const item of items) {
    if (item.personId === null || !isImageMedia(item)) continue;
    const group = grouped.get(item.personId) ?? [];
    group.push(item);
    grouped.set(item.personId, group);
  }
  const result = new Map<string, MediaItem>();
  for (const [personId, group] of grouped) {
    const photo = primaryPhoto(group);
    if (photo !== null) result.set(personId, photo);
  }
  return result;
}

function compareAttachments(left: MediaItem, right: MediaItem): number {
  if (hasCaption(left) !== hasCaption(right)) {
    return hasCaption(left) ? -1 : 1;
  }
  return (
    compareText(mediaLabel(left), mediaLabel(right)) ||
    compareText(left.id, right.id)
  );
}

/**
 * Files of one event in a deterministic order: captioned rows first (they carry
 * the user's own annotation), then by label, then by id.
 */
export function eventAttachments(
  items: readonly MediaItem[],
  eventId: string,
): MediaItem[] {
  return items
    .filter((item) => item.eventId === eventId)
    .sort(compareAttachments);
}

/** Two-letter avatar fallback: first letters of the first two words. */
export function initialsFromName(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  const letters = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("");
  return letters.toUpperCase();
}
