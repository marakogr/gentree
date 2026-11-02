import { describe, expect, it } from "vitest";
import {
  appendCustomEventType,
  buildSettingsPatch,
  customEventTypeError,
  draftFromSnapshot,
  eventFieldGroupsError,
  formatWarnings,
  isHttpUrl,
  MAX_CUSTOM_EVENT_TYPES,
  MAX_EVENT_TYPE_NAME,
  nextEventFieldType,
  parseCount,
  removeCustomEventType,
  type AppConfig,
  type SettingsDraft,
  type SettingsSnapshot,
} from "./helpers";

const config: AppConfig = {
  app: {
    language: "system",
    theme: "dark",
    style: "classic",
    graph_whole_tree: false,
  },
  event_types: { custom: [] },
  event_fields: { custom: [] },
  storage: {
    projects_dir: "/data/Gentree/projects",
    backups_dir: "/data/Gentree/backups",
    autosave_ms: 30000,
  },
  search: { index_dir: "/data/Gentree/indexes" },
  chat: {
    enabled: false,
    provider: "openai-compatible",
    base_url: "http://127.0.0.1:11434/v1",
    model: "local-model",
    api_key_env: "GENTREE_CHAT_API_KEY",
    temperature: 0.2,
    max_tokens: 2048,
    timeout_seconds: 120,
    stream: true,
    show_tools: false,
    allow_person_edits: false,
  },
  geocoder: {
    enabled: false,
    provider: "both",
    photon_base_url: "https://photon.komoot.io/api/",
    dadata_base_url:
      "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address",
    api_key_env: "DADATA_API_KEY",
    timeout_seconds: 10,
  },
  historical_geocoder: {
    enabled: true,
    api_url: "https://www.wikidata.org/w/api.php",
    timeout_seconds: 10,
  },
  map: {
    basemap: "osm",
    tile_url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  },
  backup: { enabled: true, on_close: true, daily: true, keep: 10 },
  updates: { auto_check: false },
};

const snapshot: SettingsSnapshot = {
  config,
  warnings: [],
  error: null,
  configPath: "/data/Gentree/config.yaml",
  chatApiKeyPresent: false,
  geocoderApiKeyPresent: false,
};

const draft: SettingsDraft = draftFromSnapshot(snapshot);

describe("draftFromSnapshot", () => {
  it("copies editable fields and stringifies counts", () => {
    expect(draft).toEqual({
      language: "system",
      theme: "dark",
      style: "classic",
      graphWholeTree: false,
      customEventTypes: [],
      eventFieldGroups: [],
      chatEnabled: false,
      chatBaseUrl: "http://127.0.0.1:11434/v1",
      chatModel: "local-model",
      chatApiKeyEnv: "GENTREE_CHAT_API_KEY",
      chatShowTools: false,
      chatAllowPersonEdits: false,
      geocoderEnabled: false,
      geocoderProvider: "both",
      geocoderApiKeyEnv: "DADATA_API_KEY",
      historicalEnabled: true,
      mapBasemap: "osm",
      mapTileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      updatesAutoCheck: false,
      backupKeep: "10",
    });
  });
});

describe("buildSettingsPatch", () => {
  it("returns an empty patch when nothing changed", () => {
    expect(buildSettingsPatch(draft, config)).toEqual({});
  });

  it("includes only changed keys", () => {
    const patch = buildSettingsPatch(
      { ...draft, language: "en", backupKeep: "5" },
      config,
    );
    expect(patch).toEqual({
      app: { language: "en" },
      backup: { keep: 5 },
    });
  });

  it("trims chat strings and keeps empty values meaningful", () => {
    const patch = buildSettingsPatch(
      {
        ...draft,
        chatBaseUrl: "  https://api.example.test/v1  ",
        chatModel: "",
        chatApiKeyEnv: "  MY_KEY  ",
      },
      config,
    );
    expect(patch).toEqual({
      chat: {
        base_url: "https://api.example.test/v1",
        model: "",
        api_key_env: "MY_KEY",
      },
    });
  });

  it("patches the interface style independently of the theme", () => {
    expect(buildSettingsPatch({ ...draft, style: "swiss" }, config)).toEqual({
      app: { style: "swiss" },
    });
  });

  it("patches the whole-tree feature flag only when it changed", () => {
    expect(
      buildSettingsPatch({ ...draft, graphWholeTree: true }, config),
    ).toEqual({
      app: { graph_whole_tree: true },
    });
    expect(
      buildSettingsPatch(
        { ...draft, graphWholeTree: false },
        { ...config, app: { ...config.app, graph_whole_tree: false } },
      ),
    ).toEqual({});
  });

  it("patches the style together with the theme", () => {
    expect(
      buildSettingsPatch({ ...draft, style: "swiss", theme: "light" }, config),
    ).toEqual({ app: { theme: "light", style: "swiss" } });
  });

  it("patches the chat enable flag", () => {
    expect(buildSettingsPatch({ ...draft, chatEnabled: true }, config)).toEqual({
      chat: { enabled: true },
    });
  });

  it("patches the tool-call display flag", () => {
    expect(
      buildSettingsPatch({ ...draft, chatShowTools: true }, config),
    ).toEqual({
      chat: { show_tools: true },
    });
  });

  it("patches the person-edit flag only when it changed", () => {
    expect(
      buildSettingsPatch({ ...draft, chatAllowPersonEdits: true }, config),
    ).toEqual({
      chat: { allow_person_edits: true },
    });
    expect(
      buildSettingsPatch(
        { ...draft, chatAllowPersonEdits: false },
        { ...config, chat: { ...config.chat, allow_person_edits: false } },
      ),
    ).toEqual({});
  });

  it("patches the geocoder toggle, provider and env-var name", () => {
    expect(
      buildSettingsPatch(
        {
          ...draft,
          geocoderEnabled: true,
          geocoderProvider: "dadata",
          geocoderApiKeyEnv: "  MY_DADATA_KEY  ",
        },
        config,
      ),
    ).toEqual({
      geocoder: {
        enabled: true,
        provider: "dadata",
        api_key_env: "MY_DADATA_KEY",
      },
    });
  });

  it("keeps the geocoder section out of the patch when nothing changed", () => {
    expect(
      buildSettingsPatch(
        { ...draft, geocoderApiKeyEnv: "  DADATA_API_KEY  " },
        config,
      ),
    ).toEqual({});
  });

  it("patches the historical provider switch only when it changed", () => {
    expect(
      buildSettingsPatch({ ...draft, historicalEnabled: false }, config),
    ).toEqual({
      historical_geocoder: { enabled: false },
    });
    expect(buildSettingsPatch(draft, config)).toEqual({});
  });

  it("patches the map basemap and tile URL", () => {
    expect(
      buildSettingsPatch(
        {
          ...draft,
          mapBasemap: "offline",
          mapTileUrl: "  http://127.0.0.1:8080/{z}/{x}/{y}.png ",
        },
        config,
      ),
    ).toEqual({
      map: {
        basemap: "offline",
        tile_url: "http://127.0.0.1:8080/{z}/{x}/{y}.png",
      },
    });
    expect(
      buildSettingsPatch(
        { ...draft, mapTileUrl: `  ${config.map.tile_url}  ` },
        config,
      ),
    ).toEqual({});
  });

  it("patches the update auto-check flag only when it changed", () => {
    expect(
      buildSettingsPatch({ ...draft, updatesAutoCheck: true }, config),
    ).toEqual({
      updates: { auto_check: true },
    });
    expect(
      buildSettingsPatch(
        { ...draft, updatesAutoCheck: false },
        { ...config, updates: { auto_check: false } },
      ),
    ).toEqual({});
  });

});

describe("parseCount", () => {
  it("accepts digits only", () => {
    expect(parseCount("10")).toBe(10);
    expect(parseCount(" 7 ")).toBe(7);
    expect(parseCount("0")).toBe(0);
  });

  it("rejects empty, negative and fractional input", () => {
    expect(parseCount("")).toBeNull();
    expect(parseCount("-1")).toBeNull();
    expect(parseCount("1.5")).toBeNull();
    expect(parseCount("abc")).toBeNull();
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https with a host", () => {
    expect(isHttpUrl("https://tile.openstreetmap.org/{z}/{x}/{y}.png")).toBe(
      true,
    );
    expect(isHttpUrl("  http://127.0.0.1:8080/tiles  ")).toBe(true);
  });

  it("rejects other schemes and empty values", () => {
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("file:///tiles")).toBe(false);
    expect(isHttpUrl("tile.example/{z}")).toBe(false);
  });
});

describe("formatWarnings", () => {
  it("trims, drops blanks and removes duplicates", () => {    expect(
      formatWarnings(["  unknown key  ", "", "unknown key", "second"]),
    ).toEqual(["unknown key", "second"]);
  });

  it("tolerates missing warnings", () => {
    expect(formatWarnings(null)).toEqual([]);
    expect(formatWarnings(undefined)).toEqual([]);
  });
});

describe("custom event types", () => {
  it("appends a trimmed name and rejects blanks, duplicates and long input", () => {
    expect(appendCustomEventType(["Engagement"], "  Relocation  ")).toEqual([
      "Engagement",
      "Relocation",
    ]);
    expect(appendCustomEventType(["Engagement"], "   ")).toBeNull();
    expect(appendCustomEventType(["Engagement"], "engagement")).toBeNull();
    expect(
      appendCustomEventType([], "x".repeat(MAX_EVENT_TYPE_NAME + 1)),
    ).toBeNull();
    expect(
      appendCustomEventType([], "x".repeat(MAX_EVENT_TYPE_NAME)),
    ).toEqual(["x".repeat(MAX_EVENT_TYPE_NAME)]);
  });

  it("reports the reason for the inline hint", () => {
    expect(customEventTypeError([], "  ")).toBe("empty");
    expect(customEventTypeError(["Engagement"], "ENGAGEMENT")).toBe("duplicate");
    expect(
      customEventTypeError([], "x".repeat(MAX_EVENT_TYPE_NAME + 1)),
    ).toBe("tooLong");
    expect(
      customEventTypeError(
        Array.from({ length: MAX_CUSTOM_EVENT_TYPES }, (_, index) => `t${index}`),
        "one-more",
      ),
    ).toBe("limit");
  });

  it("removes only the requested name", () => {
    expect(removeCustomEventType(["A", "B"], "A")).toEqual(["B"]);
    expect(removeCustomEventType(["A", "B"], "missing")).toEqual(["A", "B"]);
  });

  it("patches event_types only when the list changed", () => {
    expect(
      buildSettingsPatch({ ...draft, customEventTypes: ["Engagement"] }, config),
    ).toEqual({ event_types: { custom: ["Engagement"] } });
    expect(
      buildSettingsPatch(
        { ...draft, customEventTypes: ["Engagement"] },
        { ...config, event_types: { custom: ["Engagement"] } },
      ),
    ).toEqual({});
  });
});

describe("event field groups", () => {
  const group = {
    type: "OCCUPATION",
    fields: [{ key: "military_rank", label: "Military rank", multiline: false }],
  };

  it("accepts a valid group", () => {
    expect(eventFieldGroupsError([group])).toBeNull();
  });

  it("rejects invalid keys, duplicates and reserved names", () => {
    expect(
      eventFieldGroupsError([
        { ...group, fields: [{ key: "MilitaryRank", label: "Rank" }] },
      ]),
    ).toBe("keyInvalid");
    expect(
      eventFieldGroupsError([
        {
          type: "OTHER",
          fields: [
            { key: "rank", label: "Rank" },
            { key: "rank", label: "Rank 2" },
          ],
        },
      ]),
    ).toBe("keyDuplicate");
    expect(
      eventFieldGroupsError([
        { type: "OTHER", fields: [{ key: "date", label: "Date" }] },
      ]),
    ).toBe("keyReserved");
    expect(
      eventFieldGroupsError([
        { type: "OCCUPATION", fields: [{ key: "position", label: "Position" }] },
      ]),
    ).toBe("keyReserved");
  });

  it("rejects empty labels and duplicate types", () => {
    expect(
      eventFieldGroupsError([
        { type: "OTHER", fields: [{ key: "rank", label: "  " }] },
      ]),
    ).toBe("labelRequired");
    expect(eventFieldGroupsError([group, { ...group, fields: [] }])).toBe(
      "typeDuplicate",
    );
  });

  it("patches only when the edited groups differ", () => {
    expect(
      buildSettingsPatch({ ...draft, eventFieldGroups: [group] }, config),
    ).toEqual({
      event_fields: {
        custom: [
          {
            type: "OCCUPATION",
            fields: [
              { key: "military_rank", label: "Military rank", multiline: false },
            ],
          },
        ],
      },
    });
    expect(
      buildSettingsPatch(
        { ...draft, eventFieldGroups: [group] },
        { ...config, event_fields: { custom: [group] } },
      ),
    ).toEqual({});
  });

  it("picks the next unused type", () => {
    expect(nextEventFieldType([group], ["Engagement"], ["BIRTH", "OCCUPATION"]))
      .toBe("BIRTH");
    expect(nextEventFieldType([], [], ["BIRTH"])).toBe("BIRTH");
  });
});
