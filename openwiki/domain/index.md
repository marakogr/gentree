# Files

- [Date values, precision and qualifiers](dates.md) - The DateValue model for historical dates - half-open bounds, precision, qualifiers and preserved originals - and why the app never invents a timestamp.
- [People, events and validation](persons-and-events.md) - The core Person and Event records, type-specific event details, how participants and sources work, which project-wide checks run, the single-birth/single-death rule at write time versus its validation warning, and why deleting a person must not cascade through shared events.
- [Event places, coordinates and the map](places-and-map.md) - How Gentree stores and validates a confirmed place point, how the Map tab filters, groups and clusters events, how online tiles and the offline outline work, and where address suggestions and Wikidata historical names fit.
- [Relationships, graph invariants and kinship](relationships-and-kinship.md) - The four explicit relationship types, how the validated relationship set prevents self-links, duplicates and cycles, how siblings are derived, and how ancestor and descendant graphs plus path and kinship results are computed.
