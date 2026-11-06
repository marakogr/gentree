// DTOs returned by the Tauri commands. Field names are camelCase on both
// sides; Rust enums keep SCREAMING_SNAKE_CASE values.

export type AppErrorEnvelope = {
  code: string;
  params?: Record<string, string>;
  details?: unknown[];
  message?: string;
};

/** Civil date on the wire: ISO `YYYY-MM-DD` (CivilDate custom serde). */
export type CivilDate = string;

export type DatePrecision = "DAY" | "MONTH" | "YEAR" | "UNKNOWN";
export type DateQualifier =
  | "EXACT"
  | "APPROXIMATE"
  | "BEFORE"
  | "AFTER"
  | "RANGE"
  | "UNKNOWN";

export type DateValue = {
  start: CivilDate | null;
  end: CivilDate | null;
  precision: DatePrecision;
  qualifier: DateQualifier;
  original: string | null;
};

export type Gender = "MALE" | "FEMALE" | "UNKNOWN";
export type NameType = "BIRTH" | "MARRIED" | "RELIGIOUS" | "OTHER";

export type PersonName = {
  given: string | null;
  patronymic: string | null;
  surname: string | null;
  prefix: string | null;
  suffix: string | null;
  nameType: NameType;
  isPrimary: boolean;
};

export type ExternalId = { source: string; value: string };

export type Person = {
  id: string;
  gender: Gender;
  names: PersonName[];
  birth: DateValue;
  death: DateValue;
  notes: string | null;
  externalIds: ExternalId[];
};

export type PersonInput = Omit<Person, "id"> & { id?: string };

/** Compact parent row for the persons list (`person_parents` batch command). */
export type ParentRef = {
  id: string;
  name: string;
  gender: Gender;
};

export type EventType =
  | "BIRTH"
  | "DEATH"
  | "MARRIAGE"
  | "DIVORCE"
  | "BURIAL"
  | "RESIDENCE"
  | "OCCUPATION"
  | "EDUCATION"
  | "OTHER";

export type EventEntity = {
  id: string;
  personId: string;
  type: EventType;
  date: DateValue;
  place: string | null;
  /** Confirmed map point for `place` (ADR-0020); absent when not chosen. */
  placeGeo?: PlaceGeo | null;
  description: string | null;
  sourceIds: string[];
  originalType: string | null;
  /** Other people in the event; the owner is never repeated here. */
  participantIds: string[];
  /**
   * Type-specific values keyed by a stable lowercase snake_case id
   * (ADR-0015). Omitted when empty; omitted on update clears every detail.
   */
  details?: Record<string, string>;
};

export type EventInput = Omit<EventEntity, "id"> & { id?: string };

/** Opt-in online address suggestion providers (ADR-0016). */
export type GeocoderProvider = "photon" | "dadata" | "both";

/** Event map basemap (ADR-0020): online tiles or the bundled outline. */
export type MapBasemap = "osm" | "offline";

/** How precise a confirmed map point is; a settlement centroid is not a house. */
export type PlacePrecision =
  | "POINT"
  | "SETTLEMENT"
  | "REGION"
  | "COUNTRY"
  | "UNKNOWN";

/** Where a confirmed map point came from; manual points are never overwritten. */
export type PlaceSource = "PHOTON" | "DADATA" | "WIKIDATA" | "MANUAL";

/** A confirmed WGS84 point for an event place (ADR-0020). */
export type PlaceGeo = {
  lat: number;
  lon: number;
  precision: PlacePrecision;
  source: PlaceSource;
  providerRef?: string | null;
  label?: string | null;
};

/**
 * One suggestion from `place_suggest`. `source` only picks a display label;
 * the value the user confirms is always free text, never a provider id. The
 * `point` is the provider's exact object, when it has usable coordinates.
 */
export type PlaceSuggestion = {
  label: string;
  hint: string;
  source: "photon" | "dadata" | "wikidata";
  point?: PlaceGeo | null;
  /**
   * The suggestion was found by translating a historical name to its modern
   * city. The UI keeps the typed historical text instead of the modern label.
   */
  historical?: boolean;
};

/** Bulk confirmation of one point for events sharing a typed place. */
export type PlaceGeoApplyInput = {
  eventIds: string[];
  expectedPlace: string;
  point: PlaceGeo;
  overwrite?: boolean;
};

export type PlaceGeoApplyResult = {
  applied: number;
  skipped: number;
};

export type RelationshipType =
  | "PARENT_CHILD"
  | "ADOPTIVE_PARENT_CHILD"
  | "SPOUSE"
  | "PARTNER";

export type RelationshipEntity = {
  id: string;
  type: RelationshipType;
  personId: string;
  relatedPersonId: string;
  notes: string | null;
  /** `MANUAL` for user rows and legacy rows without the field. */
  origin?: RelationOrigin;
  /** Events that currently assert an automatic row; absent or empty for manual. */
  sourceEventIds?: string[];
};

export type RelationOrigin = "MANUAL" | "EVENT";

export type RelationshipInput = Omit<RelationshipEntity, "id">;

export type Versioned<T> = { entity: T; version: string };
export type Page<T> = { items: T[]; total: number };

export type PersonDetail = {
  person: Versioned<Person>;
  events: Versioned<EventEntity>[];
  relationships: Versioned<RelationshipEntity>[];
  relatedPersons: Versioned<Person>[];
};

export type RemovalPlan = {
  removedPersons: string[];
  removedEventIds: string[];
  removedRelationshipIds: string[];
  removedCitationIds: string[];
  keptEventIds: string[];
};

export type ProjectInfo = {
  projectId: string;
  name: string;
  persons: number;
  contentHash: string;
  locked: boolean;
  readOnly: boolean;
  updatedAt: string;
  homePersonId: string | null;
  /** Aggregate result of the on-open relation backfill; counts only. */
  relationBackfill?: RelationBackfillReport;
};

export type RelationBackfillReport = {
  spouseCreated: number;
  parentCreated: number;
  ambiguousSkipped: number;
  /** Missing BIRTH/DEATH events created from person dates. */
  lifeEventsCreated: number;
  /** Biological parents added to an existing child birth event. */
  parentsAdded: number;
  /** Empty patronymics filled from an already-stored biological father. */
  patronymicsFilled: number;
  readOnly: boolean;
};

/** One backup archive listed by the restore dialog. */
export type BackupInfo = {
  backupId: string;
  createdAt: string;
  sizeBytes: number;
  schemaVersion: number;
};

/** Exchange formats offered by the project export dialog. */
export type ProjectExportFormat = "AT5" | "GEDCOM";

/**
 * GEDCOM specification version. 5.5.1 is the compatibility default; 7.0 is
 * opt-in and also exports sources and citations (ADR-0019).
 */
export type ProjectExportGedcomVersion = "5.5.1" | "7.0";

export type ProjectExportResult = {
  path: string;
  fileName: string;
  bytes: number;
  warnings: string[];
};

export type ValidationIssue = {
  code: string;
  severity: "ERROR" | "WARNING";
  entityIds: string[];
  params: Record<string, string>;
};

export type ValidationReport = {
  checkedAt: string;
  issues: ValidationIssue[];
  counts: { error: number; warning: number };
};

/**
 * Backend ancestor roles plus the client-only `SIBLING` used by the graph's
 * "show siblings" expansion. No sibling edges are stored in the project.
 */
export type AncestorRole = "ROOT" | "FATHER" | "MOTHER";

/** One rendered occurrence; the same person may appear several times. */
export type AncestorNode = {
  personId: string | null;
  occurrenceKey: string;
  generation: number;
  role: AncestorRole;
  adoptive: boolean;
  placeholder: boolean;
};

export type AncestorEdge = {
  parentKey: string;
  childKey: string;
  adoptive: boolean;
};

export type AncestorGraph = {
  rootPersonId: string;
  generations: number;
  nodes: AncestorNode[];
  edges: AncestorEdge[];
  truncated: boolean;
  pedigreeCollapse: boolean;
};

/** Backend role in a descendant tree; the root is generation 0. */
export type DescendantRole = "ROOT" | "SON" | "DAUGHTER" | "CHILD";

/** One rendered descendant occurrence; the same person is drawn once. */
export type DescendantNode = {
  personId: string;
  occurrenceKey: string;
  generation: number;
  role: DescendantRole;
  adoptive: boolean;
};

export type DescendantEdge = {
  parentKey: string;
  childKey: string;
  adoptive: boolean;
};

export type DescendantGraph = {
  rootPersonId: string;
  generations: number;
  nodes: DescendantNode[];
  edges: DescendantEdge[];
  truncated: boolean;
  pedigreeCollapse: boolean;
};

export type PersonListParams = {
  query?: string;
  limit?: number;
  offset?: number;
  /** Server-side sort; `death` and `birth` keep undated persons last. */
  sort?: "name" | "birth" | "death";
  direction?: "asc" | "desc";
};

export type EventListParams = {
  personId?: string;
  type?: EventType;
  from?: string;
  to?: string;
};

/** One timeline row; `personName` is resolved by the backend. */
export type TimelineEntry = {
  event: EventEntity;
  personName: string;
  /** Optional backend-provided gender; the page falls back to its person list. */
  personGender?: Gender | null;
};

/**
 * Media attached to a person or to an event. `path` is absolute; the UI turns
 * it into an asset URL with `convertFileSrc` and never builds file paths itself.
 */
export type MediaItem = {
  id: string;
  fileName: string;
  mimeType: string;
  checksum: string;
  caption: string | null;
  personId: string | null;
  /** Event the file documents (ADR-0018); never set with `personId`. */
  eventId: string | null;
  path: string;
  isImage: boolean;
  /** `true` when this image is the person's chosen profile photo. */
  primary: boolean;
};

/** Focus of the line timeline; mirrors the Rust `timeline_list` scope. */
export type TimelineScope =
  | "all"
  | "person"
  | "ancestors"
  | "descendants"
  | "both"
  | "place";

/** Dated rows are ordered by date; undated rows follow them. */
export type TimelineResult = {
  dated: TimelineEntry[];
  undated: TimelineEntry[];
  truncated: boolean;
  /** The scope person walk hit its 5000-person cap. */
  scopeTruncated: boolean;
};

export type TimelineListParams = {
  from?: string;
  to?: string;
  personId?: string;
  types?: EventType[];
  scope?: TimelineScope;
  /** Ancestors/descendants depth; backend defaults to 10 and caps at 50. */
  generations?: number;
  /** Case-insensitive substring over `event.place` for scope=place. */
  place?: string;
};

export type EdgeDirection = "UP" | "DOWN" | "SPOUSE";

/** One node on the resolved path; `edgeToNext` is `null` on the last step. */
export type PathStep = {
  personId: string;
  edgeToNext: EdgeDirection | null;
};

export type PathResult = {
  found: boolean;
  path: PathStep[];
  length: number;
  commonAncestorId: string | null;
  spouseEdges: number;
  /** Up to two alternative routes, longest first (`[]` when there is only one). */
  alternatives?: PathResult[];
};

/** One resolved edge of a kinship chain; mirrors `core::kinship::KinshipEdge`. */
export type KinshipEdgeKind = "PARENT" | "CHILD" | "SPOUSE" | "PARTNER";

export type KinshipEdge = {
  from: string;
  to: string;
  kind: KinshipEdgeKind;
  fromGender: Gender;
  toGender: Gender;
  adoptive: boolean;
};

export type KinshipKind =
  | "FATHER"
  | "MOTHER"
  | "SON"
  | "DAUGHTER"
  | "HUSBAND"
  | "WIFE"
  | "PARTNER"
  | "BROTHER"
  | "SISTER"
  | "GRANDFATHER"
  | "GRANDMOTHER"
  | "GRANDSON"
  | "GRANDDAUGHTER"
  | "UNCLE"
  | "AUNT"
  | "NEPHEW"
  | "NIECE"
  | "COUSIN"
  | "GREAT_GRANDPARENT"
  | "GREAT_GRANDCHILD"
  | "PARENT_IN_LAW"
  | "CHILD_IN_LAW"
  | "SIBLING_IN_LAW"
  | "PARENT_OF_SPOUSE"
  | "CHILD_OF_SPOUSE"
  | "SIBLING_OF_SPOUSE"
  | "SPOUSE_OF_SIBLING"
  | "SPOUSE_OF_CHILD"
  | "SPOUSE_OF_SPOUSES_SIBLING"
  | "GREAT_UNCLE"
  | "GREAT_AUNT"
  | "GRAND_NEPHEW"
  | "GRAND_NIECE"
  | "STEP_PARENT"
  | "STEP_CHILD"
  | "STEP_SIBLING"
  | "UNKNOWN";

export type KinshipLine = "PATERNAL" | "MATERNAL" | "MIXED";

/** Structural, locale-free descriptor (ADR-0011); `formatKinship` localizes it. */
export type KinshipDescriptor = {
  kind: KinshipKind;
  gender: Gender;
  /** Gender of the person the relation is described from (ego). */
  sourceGender?: Gender;
  line: KinshipLine | null;
  degree: number;
  removed: number;
  generationDelta: number;
  viaSpouseGender: Gender | null;
  path: string[];
  /** Resolved edges of `path`, same order; `edges.length === path.length - 1`. */
  edges?: KinshipEdge[];
  commonAncestorId?: string | null;
};

export type SearchEntityType = "person" | "event" | "source";

/** Character (not byte) offsets into the snippet. */
export type SearchHighlight = { start: number; end: number };

export type SearchItem = {
  entityId: string;
  entityType: SearchEntityType;
  snippet: string;
  highlights: SearchHighlight[];
  /** Owning person for `event`; own id for `person`; absent for `source`. */
  personId?: string | null;
  /**
   * How many hits this row stands for: the backend collapses hits with the same
   * normalized snippet, so `similarCount > 1` means hidden duplicates. At least
   * 1; older payloads may omit it.
   */
  similarCount?: number;
};

export type SearchGroup = {
  entityType: SearchEntityType;
  count: number;
  items: SearchItem[];
};

export type SearchResponse = {
  groups: SearchGroup[];
  matchCount: number;
  truncated: boolean;
};

/** Source metadata for the search details panel (no sources tab exists). */
export type SourceEntity = {
  id: string;
  title: string;
  author: string | null;
  publication: string | null;
  repository: string | null;
  url: string | null;
  notes: string | null;
};

/** Built-in chat. The key never leaves the backend. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = { role: ChatRole; content: string };

export type ChatStatus = {
  enabled: boolean;
  provider: string;
  model: string;
  keyPresent: boolean;
  baseUrl: string;
  /** Read-only tool names offered to the chat model. */
  tools?: string[];
  toolsCount?: number;
  /** Feature flag: render tool calls in the transcript. */
  showTools?: boolean;
  /** Local diagnostics log path. */
  logPath?: string;
  /** True when chat edits are enabled and `update_person` is offered. */
  canEditPersons?: boolean;
};

/** Provider token accounting; fields stay snake_case as the provider sends them. */
export type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

/** Streamed Tauri events; `requestId` ties them to one `chat.send` call. */
export type ChatSkillEvent = { requestId: string; skills: string[] };
export type ChatDeltaEvent = { requestId: string; delta: string };
export type ChatDoneEvent = {
  requestId: string;
  content: string;
  usage?: ChatUsage;
};
export type ChatErrorEvent = { requestId: string; error: AppErrorEnvelope };

/** One confirmed `update_person` proposal shown as a before/after card. */
export type ChatConfirmEvent = {
  requestId: string;
  confirmationId: string;
  personId: string;
  before: Person;
  after: Person;
  changedFields: ("names" | "gender" | "birth" | "death" | "notes")[];
};

/** Chat history is app-local auxiliary data, scoped to one project id. */
export type ChatHistoryRole = "user" | "assistant";

export type ChatHistoryStatus =
  | "pending"
  | "streaming"
  | "done"
  | "error"
  | "cancelled";

export type ChatHistoryToolStatus = "running" | "ok" | "error";

export type ChatHistoryTool = {
  name: string;
  status: ChatHistoryToolStatus;
  durationMs?: number;
  arguments?: string;
  result?: string;
};

export type ChatHistoryEntry = {
  id: string;
  role: ChatHistoryRole;
  content: string;
  status: ChatHistoryStatus;
  skills: string[];
  tools: ChatHistoryTool[];
};

/** One row of the conversation list. A damaged header has a null title. */
export type ChatHistorySummary = {
  id: string;
  title: string | null;
  updatedAt: string;
  damaged: boolean;
};

export type ChatHistoryLimits = {
  maxEntries: number;
  maxConversationBytes: number;
  maxConversations: number;
  maxProjectBytes: number;
  titleMaxChars: number;
};

export type ChatHistoryList = {
  conversations: ChatHistorySummary[];
  limits: ChatHistoryLimits;
};

export type ChatHistoryConversation = {
  schema: number;
  kind: string;
  id: string;
  projectId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  entries: ChatHistoryEntry[];
};

/** AT5 import report (design.md §12). Values are stable codes, not messages. */
export type ImportConflictReason = "externalId" | "fioAndDates";

export type ImportConflict = {
  incomingIndex: number;
  existingId: string;
  reason: ImportConflictReason;
};

export type ImportReport = {
  persons: number;
  relationships: number;
  events: number;
  media: number;
  warnings: string[];
  issues: string[];
  conflicts: ImportConflict[];
};

export type ImportPreview = { report: ImportReport };

export type ImportResult = { project: ProjectInfo; report: ImportReport };

/**
 * `import_probe`: what a dropped or picked path is. `format` is the reader the
 * import should use, decided from the file content and, as a fallback, the
 * extension. A folder has `isDir = true` and no format.
 */
export type ImportProbe = {
  isDir: boolean;
  format: "at5" | "gedcom" | null;
};

/* -------------------------------------------------------------------------- */
/* Project merge (ADR-0017)                                                    */
/* -------------------------------------------------------------------------- */

/** Matcher confidence; Rust serializes the enum variants as-is. */
export type MergeMatchConfidence = "High" | "Medium" | "Ambiguous";

/** What the user decided for one suggested pair. */
export type MergeAction = "Merge" | "KeepBoth";

/** Base card / base event of a merged row. */
export type MergeSide = "Left" | "Right";

/** Per-field resolution; `Both` is only meaningful for text fields. */
export type MergeFieldPolicy = "Left" | "Right" | "Both";

/** A person as `merge_preview` presents it. */
export type MergePerson = {
  id: string;
  names: PersonName[];
  gender: Gender;
  birth: DateValue;
  death: DateValue;
  notes: string | null;
  externalIds: ExternalId[];
};

/** An event as `merge_preview` presents it; the owner is implied by grouping. */
export type MergeEvent = {
  id: string;
  type: EventType;
  date: DateValue;
  place: string | null;
  placeGeo?: PlaceGeo | null;
  description: string | null;
  details: Record<string, string>;
  participantIds: string[];
  sourceIds: string[];
  originalType: string | null;
};

/** One piece of explainable evidence behind a suggestion. */
export type MergeEvidence = {
  code: string;
  params: Record<string, string>;
};

/** A non-blocking observation produced by the preview or apply step. */
export type MergeWarning = {
  code: string;
  params: Record<string, string>;
};

export type MergeEventMatch = {
  id: string;
  left: MergeEvent;
  right: MergeEvent;
  confidence: MergeMatchConfidence;
  evidence: MergeEvidence[];
  fieldDiffs: string[];
};

export type MergePersonMatch = {
  id: string;
  left: MergePerson;
  right: MergePerson;
  confidence: MergeMatchConfidence;
  evidence: MergeEvidence[];
  leftEvents: MergeEvent[];
  rightEvents: MergeEvent[];
  eventMatches: MergeEventMatch[];
  fieldDiffs: string[];
};

export type MergePreviewCounts = {
  leftPeople: number;
  rightPeople: number;
  leftEvents: number;
  rightEvents: number;
  matchedPeople: number;
  matchedEvents: number;
  ambiguousPeople: number;
};

export type MergePreview = {
  matches: MergePersonMatch[];
  /** Right people without a suggestion; they are copied as new. */
  unmatchedRight: MergePerson[];
  warnings: MergeWarning[];
  counts: MergePreviewCounts;
};

/** Decision for one suggested person pair. */
export type PersonDecision = {
  leftId: string;
  rightId: string;
  action: MergeAction;
  base: MergeSide;
  fields: Record<string, MergeFieldPolicy>;
};

/** Decision for one suggested event pair. */
export type EventDecision = {
  leftEventId: string;
  rightEventId: string;
  action: MergeAction;
  base: MergeSide;
  fields: Record<string, MergeFieldPolicy>;
};

/** The complete decision payload; a missing decision keeps both rows. */
export type MergeDecisions = {
  persons: PersonDecision[];
  events: EventDecision[];
};

export type MergeReport = {
  mergedPeople: number;
  keptBothPeople: number;
  unmatchedRightPeople: number;
  mergedEvents: number;
  keptBothEvents: number;
  warnings: MergeWarning[];
};

/** `merge_apply` request body (the Tauri command wraps it in `request`). */
export type MergeApplyRequest = {
  leftProjectId: string;
  rightProjectId: string;
  name: string;
  decisions: MergeDecisions;
};

export type MergeApplyResult = {
  project: ProjectInfo;
  report: MergeReport;
};

/** Result of one automatic startup check, when `updates.auto_check` is on. */
export type AutoCheckOutcome = {
  /** RFC 3339, UTC. */
  checkedAt: string;
  availableVersion: string | null;
  /** Stable error code; the UI localizes `errors.<code>`. */
  errorCode: string | null;
};

/**
 * `update_status` / `update_check` / `update_install`. Only the two action
 * commands touch the network; status is a read of the config and last result.
 */
export type UpdateStatus = {
  currentVersion: string;
  /** `"direct"`: the app updates itself from the release feed. `"store"`: the
   * Microsoft Store delivers updates and this build never checks on its own. */
  channel: "direct" | "store";
  /** False while the endpoint or public key is a release placeholder. */
  configured: boolean;
  autoCheck: boolean;
  availableVersion: string | null;
  notes: string | null;
  lastAutoCheck: AutoCheckOutcome | null;
};
