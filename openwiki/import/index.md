# Files

- [AT5 import pipeline](at5.md) - How Gentree reads an AT5 SQLite database without modifying it, maps EAV or person-table shapes into core records, reports what it could not understand, and keeps re-imports idempotent.
- [GEDCOM and AT5 export/interchange](interchange.md) - The four exchange formats - AT5 and GEDCOM archives, media-free JSON and full project ZIP - how they are written atomically, which losses are reported, and which safety limits apply on import.
