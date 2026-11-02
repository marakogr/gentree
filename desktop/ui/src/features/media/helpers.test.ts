import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../api/types";
import {
  eventAttachments,
  initialsFromName,
  isImageMedia,
  mediaKind,
  mediaLabel,
  photosByPerson,
  primaryPhoto,
} from "./helpers";

function media(
  id: string,
  fileName: string,
  overrides: Partial<MediaItem> = {},
): MediaItem {
  return {
    id,
    fileName,
    mimeType: "image/jpeg",
    checksum: `sum-${id}`,
    caption: null,
    personId: "p1",
    eventId: null,
    path: `C:\\media\\${fileName}`,
    isImage: true,
    primary: false,
    ...overrides,
  };
}

describe("isImageMedia / mediaKind", () => {
  it("trusts the isImage flag and falls back to the MIME prefix", () => {
    expect(isImageMedia({ isImage: true, mimeType: "application/pdf" })).toBe(
      true,
    );
    expect(isImageMedia({ isImage: false, mimeType: "image/png" })).toBe(true);
    expect(isImageMedia({ isImage: false, mimeType: "application/pdf" })).toBe(
      false,
    );
    expect(mediaKind(media("1", "photo.jpg"))).toBe("image");
    expect(
      mediaKind(
        media("2", "record.pdf", {
          mimeType: "application/pdf",
          isImage: false,
        }),
      ),
    ).toBe("document");
  });
});

describe("primaryPhoto", () => {
  it("returns null when there is no image", () => {
    expect(
      primaryPhoto([
        media("d1", "record.pdf", {
          mimeType: "application/pdf",
          isImage: false,
        }),
      ]),
    ).toBeNull();
    expect(primaryPhoto([])).toBeNull();
  });

  it("prefers a captioned image and breaks ties deterministically", () => {
    const photo = primaryPhoto([
      media("3", "z-last.jpg"),
      media("2", "a-first.jpg"),
      media("1", "portrait.jpg", { caption: "  Grandmother  " }),
      media("d1", "record.pdf", {
        mimeType: "application/pdf",
        isImage: false,
      }),
    ]);
    expect(photo?.id).toBe("1");

    const tie = primaryPhoto([
      media("b", "same.jpg"),
      media("a", "same.jpg"),
    ]);
    expect(tie?.id).toBe("a");

    const byName = primaryPhoto([
      media("b", "b.jpg"),
      media("a", "a.jpg"),
    ]);
    expect(byName?.fileName).toBe("a.jpg");
  });

  it("prefers the image explicitly marked as the profile photo", () => {
    const photo = primaryPhoto([
      media("1", "portrait.jpg", { caption: "Portrait" }),
      media("2", "chosen.jpg", { primary: true }),
      media("3", "another.jpg", { primary: true }),
    ]);
    // Several marked rows (legacy data) still resolve deterministically.
    expect(photo?.id).toBe("3");

    // A marked image wins over an unmarked but better-sorted one.
    expect(
      primaryPhoto([
        media("a", "a.jpg"),
        media("z", "z.jpg", { primary: true }),
      ])?.id,
    ).toBe("z");
  });
});

describe("photosByPerson", () => {
  it("keeps one primary image per person and ignores documents", () => {
    const map = photosByPerson([
      media("1", "first.jpg", { personId: "p1" }),
      media("2", "better.jpg", { personId: "p1", caption: "Portrait" }),
      media("3", "second.jpg", { personId: "p2" }),
      media("4", "scan.pdf", {
        personId: "p3",
        mimeType: "application/pdf",
        isImage: false,
      }),
      media("5", "orphan.jpg", { personId: null }),
    ]);
    expect([...map.keys()].sort()).toEqual(["p1", "p2"]);
    expect(map.get("p1")?.id).toBe("2");
    expect(map.get("p2")?.id).toBe("3");
  });
});

describe("mediaLabel", () => {
  it("uses a trimmed caption before the file name", () => {
    expect(mediaLabel(media("1", "photo.jpg", { caption: "  " }))).toBe(
      "photo.jpg",
    );
    expect(mediaLabel(media("2", "photo.jpg", { caption: " Portrait " }))).toBe(
      "Portrait",
    );
  });
});

describe("eventAttachments", () => {
  it("returns one event's files with captioned rows first", () => {
    const files = eventAttachments(
      [
        media("b", "z-scan.pdf", { personId: null, eventId: "e1", isImage: false, mimeType: "application/pdf" }),
        media("a", "a-scan.pdf", { personId: null, eventId: "e1", isImage: false, mimeType: "application/pdf" }),
        media("c", "certificate.pdf", { personId: null, eventId: "e1", caption: " Certificate " }),
        media("d", "other.pdf", { personId: null, eventId: "e2" }),
        media("e", "person.jpg", { personId: "p1", eventId: null }),
      ],
      "e1",
    );
    expect(files.map((item) => item.id)).toEqual(["c", "a", "b"]);
  });

  it("breaks ties on the id, so the order is stable", () => {
    const files = eventAttachments(
      [
        media("z", "same.pdf", { personId: null, eventId: "e1" }),
        media("a", "same.pdf", { personId: null, eventId: "e1" }),
      ],
      "e1",
    );
    expect(files.map((item) => item.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the input list", () => {
    const items = [
      media("b", "b.pdf", { personId: null, eventId: "e1" }),
      media("a", "a.pdf", { personId: null, eventId: "e1" }),
    ];
    eventAttachments(items, "e1");
    expect(items.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("initialsFromName", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsFromName("Petrov Ivan")).toBe("PI");
    expect(initialsFromName("  petrova   anna  ")).toBe("PA");
    expect(initialsFromName("Petrov Ivan Ivanovich")).toBe("PI");
  });

  it("handles single words, Cyrillic and empty names", () => {
    expect(initialsFromName("Ivan")).toBe("I");
    expect(initialsFromName("\u041f\u0435\u0442\u0440\u043e\u0432")).toBe(
      "\u041f",
    );
    expect(initialsFromName("   ")).toBe("?");
    expect(initialsFromName("")).toBe("?");
  });
});
