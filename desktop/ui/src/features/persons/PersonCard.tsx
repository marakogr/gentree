import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Avatar,
  Badge,
  Button as FluentButton,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type { AccordionToggleEventHandler } from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  ArrowMaximizeRegular,
  AttachRegular,
  CameraRegular,
  DeleteRegular,
  DismissRegular,
  DocumentRegular,
  HistoryRegular,
  OpenRegular,
  OrganizationRegular,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { mediaApi, personsApi, relationshipsApi } from "../../api/client";
import type {
  DateValue,
  EventEntity,
  EventType,
  MediaItem,
  Person,
  PersonDetail,
  RelationshipEntity,
  RelationshipInput,
  Versioned,
} from "../../api/types";
import { ErrorBanner } from "../../components/feedback";
import { Button } from "../../components/ui/button";
import { Combobox } from "../../components/ui/combobox";
import { EmptyState } from "../../components/ui/empty";
import { Field } from "../../components/ui/field";
import { IconButton } from "../../components/ui/icon-button";
import { MenuButton, type MenuItem } from "../../components/ui/menu";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { dash, EMPTY_VALUE } from "../../lib/formatValue";
import { useDateFormatter } from "../../lib/useDateFormatter";
import EventForm from "../events/EventForm";
import { eventDetailEntries } from "../events/fields";
import { eventTypeLabel } from "../events/helpers";
import { useEventConfig } from "../events/useEventConfig";
import {
  initialsFromName,
  isImageMedia,
  mediaLabel,
  primaryPhoto,
} from "../media/helpers";
import { KinshipPanel } from "../path/KinshipPanel";
import {
  personNavigationLabelKey,
  type PersonNavigationAction,
} from "./actions";
import { buildEventTimeline, childrenOf } from "./eventTimeline";
import { occupationPositions } from "./occupations";
import { relationDirection, relationLabelKey } from "./relationLabel";
import {
  ageInCompletedYears,
  ageTone,
  displayName,
  lifeYears,
  sortPersons,
} from "./helpers";
import "./persons.css";

/**
 * What the selected person is to the current person. The form never exposes a
 * raw edge type: the direction decides which endpoint is the parent/owner.
 */
type RelationshipRole = "parent" | "child" | "spouse" | "partner" | "adoptiveParent";

const RELATIONSHIP_ROLES: RelationshipRole[] = [
  "parent",
  "child",
  "spouse",
  "partner",
  "adoptiveParent",
];

const ROLE_LABEL_KEYS: Record<RelationshipRole, string> = {
  parent: "relationship:addParent",
  child: "relationship:addChild",
  spouse: "relationship:addSpouse",
  partner: "relationship:addPartner",
  adoptiveParent: "relationship:addAdoptiveParent",
};

/** Edge to create for a role; the current person is the child/owner by default. */
function relationshipForRole(
  role: RelationshipRole,
  personId: string,
  relatedId: string,
): RelationshipInput {
  switch (role) {
    case "parent":
      return {
        type: "PARENT_CHILD",
        personId: relatedId,
        relatedPersonId: personId,
        notes: null,
      };
    case "child":
      return {
        type: "PARENT_CHILD",
        personId,
        relatedPersonId: relatedId,
        notes: null,
      };
    case "adoptiveParent":
      return {
        type: "ADOPTIVE_PARENT_CHILD",
        personId: relatedId,
        relatedPersonId: personId,
        notes: null,
      };
    case "spouse":
      return {
        type: "SPOUSE",
        personId,
        relatedPersonId: relatedId,
        notes: null,
      };
    case "partner":
      return {
        type: "PARTNER",
        personId,
        relatedPersonId: relatedId,
        notes: null,
      };
  }
}

type SectionId = "facts" | "events" | "family" | "kinship" | "files";

const SECTION_IDS: SectionId[] = ["facts", "events", "family", "kinship", "files"];

type Props = {
  detail: PersonDetail;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
  /** Shell-level navigation; hidden when the card is rendered without a shell. */
  onNavigate?: (action: PersonNavigationAction, personId: string) => void;
  /** Legacy screens (graph/path) still close the card through this prop. */
  onBack?: () => void;
  /** Opens this card in a window of its own; the shell owns that window. */
  onExpand?: () => void;
  /** Owned persons list; the card loads its own copy when omitted. */
  persons?: Person[];
  projectId?: string;
  homePersonId?: string | null;
  onOpenPerson?: (personId: string) => void;
  busy?: boolean;
};

type SectionProps = {
  id: SectionId;
  title: string;
  /** Real row count shown next to the title; omitted where it adds nothing. */
  count?: number;
  action?: ReactNode;
  children: ReactNode;
};

// Fluent owns the accordion interaction and the theme tokens; only the card
// layout and the "looks like a link" buttons need a local class.
const useStyles = makeStyles({
  accordion: {
    rowGap: tokens.spacingVerticalS,
  },
  avatarButton: {
    height: "auto",
    minWidth: 0,
    padding: 0,
    borderRadius: tokens.borderRadiusCircular,
  },
  nameTitle: {
    margin: 0,
  },
  sectionHeader: {
    flex: "1 1 auto",
    minWidth: 0,
  },
  sectionBody: {
    display: "grid",
    rowGap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  // In-cell actions stay buttons (they open forms), but read like links.
  linkButton: {
    minWidth: 0,
    height: "auto",
    padding: 0,
    justifyContent: "flex-start",
    color: tokens.colorBrandForegroundLink,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightRegular,
    textAlign: "left",
    whiteSpace: "normal",
    ":hover": {
      color: tokens.colorBrandForegroundLinkHover,
      textDecorationLine: "underline",
    },
    ":hover:active": {
      color: tokens.colorBrandForegroundLinkPressed,
    },
  },
  // The event type is the row's headline, not a secondary cell action.
  eventTypeLink: {
    fontWeight: tokens.fontWeightSemibold,
  },
  mutedText: {
    color: tokens.colorNeutralForeground3,
  },
  notesText: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  actionsCell: {
    width: "5.5rem",
    textAlign: "right",
  },
  // Fluent tables are `table-layout: fixed`; the card is narrow and the
  // description column needs to keep its content-based width.
  table: {
    tableLayout: "auto",
  },
  mediaThumb: {
    display: "block",
    width: "96px",
    height: "96px",
    minWidth: "96px",
    padding: 0,
    overflow: "hidden",
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  mediaThumbImage: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
});

function Section({ id, title, count, action, children }: SectionProps) {
  const styles = useStyles();
  return (
    <AccordionItem value={id} className="person-section">
      <div className="person-section-head">
        <AccordionHeader
          as="h3"
          className={styles.sectionHeader}
          expandIconPosition="start"
        >
          <span className="person-section-title">
            {title}
            {count === undefined ? null : (
              <span className="person-section-count">{count}</span>
            )}
          </span>
        </AccordionHeader>
        {action}
      </div>
      <AccordionPanel className={styles.sectionBody}>{children}</AccordionPanel>
    </AccordionItem>
  );
}

export default function PersonCard({
  detail,
  onEdit,
  onDelete,
  onChanged,
  onNavigate,
  onBack,
  onExpand,
  persons,
  projectId,
  homePersonId = null,
  onOpenPerson,
  busy = false,
}: Props) {
  const { t } = useTranslation([
    "person",
    "common",
    "enums",
    "relationship",
    "event",
  ]);
  const formatDate = useDateFormatter();
  const styles = useStyles();
  const relationshipFieldId = useId();
  const { fieldGroups } = useEventConfig();
  const person = detail.person.entity;
  const [today] = useState(() => new Date());

  const [loadedPersons, setLoadedPersons] = useState<Person[]>([]);
  const [role, setRole] = useState<RelationshipRole>("parent");
  const [relatedId, setRelatedId] = useState("");
  const [relationshipFormOpen, setRelationshipFormOpen] = useState(false);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [filesByEvent, setFilesByEvent] = useState<Record<string, number>>(
    {},
  );
  const [mediaVersion, setMediaVersion] = useState(0);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState<AppErrorEnvelope | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [settingPrimary, setSettingPrimary] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);
  const [editingEvent, setEditingEvent] = useState<Versioned<EventEntity> | null>(
    null,
  );
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [createEventType, setCreateEventType] = useState<EventType | undefined>(
    undefined,
  );
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>(
    () => ({
      facts: true,
      events: detail.events.length > 0,
      family: detail.relationships.length > 0,
      kinship: true,
      files: false,
    }),
  );

  const personName = displayName(person, t("person:unknownName"));
  const tone = ageTone(person, today);
  const age = ageInCompletedYears(person, today);
  const primary = useMemo(() => primaryPhoto(media), [media]);
  const images = useMemo(() => media.filter(isImageMedia), [media]);
  const documents = useMemo(
    () => media.filter((item) => !isImageMedia(item)),
    [media],
  );
  const allPersons = persons ?? loadedPersons;
  // Every person picker follows the list screen: youngest first, undated last,
  // name ascending on a tie.
  const sortedPersons = useMemo(
    () => sortPersons(allPersons, "birth", "desc"),
    [allPersons],
  );
  // Children of the open person become derived birth rows in the timeline.
  // `detail.relatedPersons` only fills gaps while the full list is loading.
  const timelineChildren = useMemo(() => {
    const byId = new Map(allPersons.map((item) => [item.id, item]));
    for (const item of detail.relatedPersons) {
      if (!byId.has(item.entity.id)) byId.set(item.entity.id, item.entity);
    }
    return childrenOf(person.id, detail.relationships, [...byId.values()]);
  }, [allPersons, detail.relatedPersons, detail.relationships, person.id]);
  // Rows of the events timeline: stored events and derived child births,
  // sorted together; labels resolved once.
  const eventRows = useMemo(
    () =>
      buildEventTimeline(detail.events, {
        formatDate,
        typeLabel: (event) =>
          eventTypeLabel(event.type, event.originalType, t),
        detailEntries: (event) =>
          eventDetailEntries(event, fieldGroups, (key) =>
            t(`event:fields.${key}`),
          ),
        children: timelineChildren,
        childBirthLabel: t("person:childBirth"),
        personName: (child) => displayName(child, t("person:unknownName")),
      }),
    [detail.events, fieldGroups, formatDate, t, timelineChildren],
  );
  // The occupation fact reuses the timeline rows, so its positions follow the
  // same oldest-first order and open the matching event.
  const occupations = useMemo(
    () => occupationPositions(eventRows),
    [eventRows],
  );
  // The current person is always offered, even while the full list is still
  // loading: "add event" from the card must not depend on that request.
  const eventPersons = useMemo(() => {
    const items = sortedPersons.map((entity) => ({ entity }));
    if (!items.some((item) => item.entity.id === person.id)) {
      items.push({ entity: person });
    }
    return items;
  }, [sortedPersons, person]);

  // The accordion only ever receives values of the sections it actually
  // renders; the record above stays the single source of truth.
  const sectionIds = useMemo(
    () => (projectId ? SECTION_IDS : SECTION_IDS.filter((id) => id !== "kinship")),
    [projectId],
  );
  const openItems = useMemo(
    () => sectionIds.filter((id) => openSections[id]),
    [sectionIds, openSections],
  );

  // Fluent reports the whole open list; mirror it back onto the rendered
  // sections only, so state of a hidden one is not dropped.
  const handleSectionToggle: AccordionToggleEventHandler<SectionId> = (
    _event,
    data,
  ) => {
    const open = new Set<SectionId>(data.openItems);
    setOpenSections((current) => {
      const next = { ...current };
      for (const id of sectionIds) next[id] = open.has(id);
      return next;
    });
  };

  useEffect(() => {
    if (persons) return undefined;
    let active = true;
    void personsApi
      .list({ limit: 1000, sort: "name" })
      .then((page) => {
        if (active) setLoadedPersons(page.items.map((item) => item.entity));
      })
      .catch((caught: unknown) => {
        if (active) setError(normalizeError(caught));
      });
    return () => {
      active = false;
    };
  }, [persons, person.id]);

  useEffect(() => {
    let active = true;
    setMediaLoading(true);
    setMediaError(null);
    // Person files and the per-event indicator come from two small calls:
    // event attachments have no `personId` (ADR-0018).
    Promise.all([mediaApi.list(person.id), mediaApi.eventCounts()])
      .then(([items, counts]) => {
        if (!active) return;
        setMedia(items);
        setFilesByEvent(counts);
      })
      .catch((caught: unknown) => {
        if (active) {
          setMedia([]);
          setFilesByEvent({});
          setMediaError(normalizeError(caught));
        }
      })
      .finally(() => {
        if (active) setMediaLoading(false);
      });
    return () => {
      active = false;
    };
  }, [person.id, mediaVersion]);

  // Content that arrives later (media, refreshed detail) opens its section once.
  useEffect(() => {
    setOpenSections((current) => ({
      ...current,
      events: current.events || eventRows.length > 0,
      family: current.family || detail.relationships.length > 0,
      files: current.files || media.length > 0,
    }));
  }, [eventRows.length, detail.relationships.length, media.length]);

  useEffect(() => {
    if (lightbox === null) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightbox]);

  const dateText = (value: DateValue): string =>
    value.start || value.original ? formatDate(value) : EMPTY_VALUE;

  const openNewEvent = () => {
    setEditingEvent(null);
    setCreateEventType(undefined);
    setOpenSections((current) => ({ ...current, events: true }));
    setCreatingEvent(true);
  };

  const openEvent = (row: Versioned<EventEntity>) => {
    setCreatingEvent(false);
    setEditingEvent(row);
  };

  const openMedia = (item: MediaItem) => {
    void mediaApi.open(item.id).catch((caught: unknown) => {
      setMediaError(normalizeError(caught));
    });
  };

  const downloadMedia = (item: MediaItem) => {
    void (async () => {
      try {
        const target = await save({ defaultPath: item.fileName });
        if (!target) return;
        await mediaApi.saveAs(item.id, target);
        setMediaError(null);
      } catch (caught) {
        setMediaError(normalizeError(caught));
      }
    })();
  };

  const attachMedia = () => {
    void (async () => {
      try {
        setOpenSections((current) => ({ ...current, files: true }));
        const selected = await open({ multiple: false, directory: false });
        const source = Array.isArray(selected) ? selected[0] : selected;
        if (!source) return;
        setAttaching(true);
        await mediaApi.attach(person.id, source);
        setMedia(await mediaApi.list(person.id));
        setMediaError(null);
      } catch (caught) {
        setMediaError(normalizeError(caught));
      } finally {
        setAttaching(false);
      }
    })();
  };

  // Profile photo: attach the picked image and make it the primary one in a
  // single backend call, then reload the list so the avatar updates.
  const editProfilePhoto = () => {
    void (async () => {
      try {
        const selected = await open({
          multiple: false,
          directory: false,
          filters: [
            {
              name: "JPEG, PNG, GIF, WebP, BMP",
              extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"],
            },
          ],
        });
        const source = Array.isArray(selected) ? selected[0] : selected;
        if (!source) return;
        setAttaching(true);
        await mediaApi.attach(person.id, source, true);
        setMedia(await mediaApi.list(person.id));
        setMediaError(null);
        setOpenSections((current) => ({ ...current, files: true }));
      } catch (caught) {
        setMediaError(normalizeError(caught));
      } finally {
        setAttaching(false);
      }
    })();
  };

  const makePrimary = (item: MediaItem) => {
    void (async () => {
      try {
        setSettingPrimary(item.id);
        await mediaApi.setPrimary(person.id, item.id);
        setMedia(await mediaApi.list(person.id));
        setMediaError(null);
      } catch (caught) {
        setMediaError(normalizeError(caught));
      } finally {
        setSettingPrimary(null);
      }
    })();
  };

  const relatedPersonId = (row: RelationshipEntity): string =>
    row.personId === person.id ? row.relatedPersonId : row.personId;

  // The related person carries the gender used by the directional label; a
  // missing row falls back to the neutral form instead of guessing.
  const relatedPerson = (row: RelationshipEntity): Person | undefined =>
    detail.relatedPersons.find(
      (item) => item.entity.id === relatedPersonId(row),
    )?.entity;

  const relatedName = (row: RelationshipEntity): string => {
    const found = relatedPerson(row);
    return found
      ? displayName(found, t("person:unknownName"))
      : relatedPersonId(row);
  };

  const addRelationship = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setStale(false);
    if (relatedId === "") return;
    setSaving(true);
    try {
      await relationshipsApi.create(
        relationshipForRole(role, person.id, relatedId),
      );
      setRelatedId("");
      setRole("parent");
      setRelationshipFormOpen(false);
      onChanged();
    } catch (caught) {
      const normalized = normalizeError(caught);
      if (normalized.code === "STALE_WRITE") setStale(true);
      else setError(normalized);
    } finally {
      setSaving(false);
    }
  };

  const openRelationshipForm = () => {
    setOpenSections((current) => ({ ...current, family: true }));
    setRelationshipFormOpen(true);
  };

  const cancelRelationshipForm = () => {
    setRelatedId("");
    setRole("parent");
    setRelationshipFormOpen(false);
  };

  const removeRelationship = async (row: Versioned<RelationshipEntity>) => {
    const message =
      row.entity.origin === "EVENT"
        ? t("relationship:deleteAutomaticConfirm")
        : t("relationship:deleteConfirm");
    if (!window.confirm(message)) return;
    setError(null);
    setStale(false);
    setSaving(true);
    try {
      await relationshipsApi.delete(row.entity.id, row.version);
      onChanged();
    } catch (caught) {
      const normalized = normalizeError(caught);
      if (normalized.code === "STALE_WRITE") setStale(true);
      else setError(normalized);
    } finally {
      setSaving(false);
    }
  };

  const roleItems = RELATIONSHIP_ROLES.map((candidate) => ({
    id: candidate,
    label: t(ROLE_LABEL_KEYS[candidate]),
  }));

  const pickerItems = sortedPersons
    .filter((item) => item.id !== person.id)
    .map((item) => ({
      id: item.id,
      label: displayName(item, t("person:unknownName")),
      hint: [item.birth.start?.slice(0, 4), item.death.start?.slice(0, 4)]
        .filter(Boolean)
        .join("–"),
    }));

  const menuItems: MenuItem[] = [];
  if (onNavigate) {
    menuItems.push({
      id: "tree",
      label: t(personNavigationLabelKey("tree")),
      icon: <OrganizationRegular aria-hidden="true" />,
      onSelect: () => onNavigate("tree", person.id),
    });
    menuItems.push({
      id: "timeline",
      label: t(personNavigationLabelKey("timeline")),
      icon: <HistoryRegular aria-hidden="true" />,
      onSelect: () => onNavigate("timeline", person.id),
    });
  }
  menuItems.push({
    id: "delete",
    label: t("common:actions.delete"),
    icon: <DeleteRegular aria-hidden="true" />,
    danger: true,
    disabled: busy,
    disabledReason: busy ? t("person:busyReason") : undefined,
    onSelect: onDelete,
  });

  const hasRelationships = detail.relationships.length > 0;

  return (
    <section className="persons-panel person-card" aria-labelledby="person-card-title">
      <header className="person-card-head">
        <div className="person-card-identity">
          <div className="person-avatar">
            {primary ? (
              <FluentButton
                appearance="transparent"
                className={styles.avatarButton}
                aria-label={t("person:openPhoto", { name: personName })}
                title={t("person:openPhoto", { name: personName })}
                onClick={() => setLightbox(primary)}
              >
                <Avatar
                  name={personName}
                  size={96}
                  shape="circular"
                  color="colorful"
                  initials={initialsFromName(personName)}
                  image={{
                    src: convertFileSrc(primary.path),
                    alt: t("person:photoOf", { name: personName }),
                  }}
                />
              </FluentButton>
            ) : (
              <Avatar
                name={personName}
                size={96}
                shape="circular"
                color="colorful"
                initials={initialsFromName(personName)}
                aria-hidden="true"
              />
            )}
            <FluentButton
              appearance="primary"
              size="small"
              shape="circular"
              className="person-avatar-edit"
              icon={<CameraRegular aria-hidden="true" />}
              aria-label={t("person:editProfilePhoto")}
              title={t("person:editProfilePhoto")}
              disabled={attaching}
              onClick={editProfilePhoto}
            />
          </div>
          <div className="person-card-title">
            <Title3 as="h2" id="person-card-title" className={styles.nameTitle}>
              {personName}
            </Title3>
            <div className="person-card-meta">
              <Badge appearance="tint" color="informative" size="medium">
                {t(`enums:gender.${person.gender}`)}
              </Badge>
              <Text
                size={200}
                wrap={false}
                className={mergeClasses("person-years", styles.mutedText)}
              >
                {lifeYears(person)}
              </Text>
            </div>
          </div>
        </div>
        <div className="person-card-actions">
          {onExpand ? (
            <IconButton
              label={t("person:openInWindow")}
              onClick={onExpand}
            >
              <ArrowMaximizeRegular aria-hidden="true" />
            </IconButton>
          ) : null}
          {onBack ? (
            <IconButton label={t("person:closeCard")} onClick={onBack}>
              <DismissRegular aria-hidden="true" />
            </IconButton>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
            {t("common:actions.edit")}
          </Button>
          <MenuButton
            label={t("person:moreActions")}
            items={menuItems}
            iconOnly
            align="end"
          />
        </div>
      </header>

      {stale ? (
        <div className="error-block" role="alert">
          <p className="error">{t("common:errors.STALE_WRITE")}</p>
          <p className="meta">{t("relationship:conflict")}</p>
          <Button variant="secondary" size="sm" onClick={onChanged}>
            {t("common:actions.reload")}
          </Button>
        </div>
      ) : null}
      <ErrorBanner error={error} />

      <Accordion<SectionId>
        className={styles.accordion}
        multiple
        collapsible
        openItems={openItems}
        onToggle={handleSectionToggle}
      >
        <Section id="facts" title={t("person:sections.facts")}>
          <dl className="facts person-facts">
            <dt>
              <Text size={200} weight="semibold" className={styles.mutedText}>
                {t("person:names")}
              </Text>
            </dt>
            <dd>
              {person.names.length === 0 ? (
                <Text size={200}>{EMPTY_VALUE}</Text>
              ) : (
                <ul className="plain person-names">
                  {person.names.map((name, index) => (
                    <li key={`${name.nameType}-${index}`}>
                      <Text size={200}>
                        {[name.surname, name.given, name.patronymic]
                          .filter(Boolean)
                          .join(" ") || EMPTY_VALUE}
                      </Text>
                      <Text size={100} className={styles.mutedText}>
                        {" "}
                        · {t(`enums:nameType.${name.nameType}`)}
                        {name.isPrimary ? ` · ${t("person:primaryName")}` : ""}
                      </Text>
                    </li>
                  ))}
                </ul>
              )}
            </dd>

            <dt>
              <Text size={200} weight="semibold" className={styles.mutedText}>
                {t("person:birth")}
              </Text>
            </dt>
            <dd>
              <Text size={200}>{dateText(person.birth)}</Text>
            </dd>

            <dt>
              <Text size={200} weight="semibold" className={styles.mutedText}>
                {t("person:death")}
              </Text>
            </dt>
            <dd>
              <Text size={200}>{dateText(person.death)}</Text>
            </dd>

            <dt>
              <Text size={200} weight="semibold" className={styles.mutedText}>
                {t("person:age")}
              </Text>
            </dt>
            <dd>
              {age === null ? (
                <Text size={200}>{EMPTY_VALUE}</Text>
              ) : (
                <Text size={200} className={`person-age person-age-${tone}`}>
                  {age}
                </Text>
              )}
            </dd>

            <dt>
              <Text size={200} weight="semibold" className={styles.mutedText}>
                {t("enums:eventType.OCCUPATION")}
              </Text>
            </dt>
            <dd data-testid="person-occupation">
              <Text size={200}>
                {occupations.length === 0
                  ? EMPTY_VALUE
                  : occupations.join(", ")}
              </Text>
            </dd>

            <dt>
              <Text size={200} weight="semibold" className={styles.mutedText}>
                {t("person:notes")}
              </Text>
            </dt>
            <dd className="person-notes">
              <Text size={200} className={styles.notesText}>
                {dash(person.notes)}
              </Text>
            </dd>
          </dl>
        </Section>

        <Section
          id="events"
          title={t("person:sections.events")}
          count={eventRows.length}
          action={
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={openNewEvent}
            >
              + {t("event:new")}
            </Button>
          }
        >
          {eventRows.length === 0 ? (
            <EmptyState
              compact
              text={t("person:noEvents")}
              actionLabel={t("event:new")}
              onAction={openNewEvent}
            />
          ) : (
            <ol
              className="person-timeline"
              aria-label={t("person:eventsTimeline")}
              // WebKit drops list semantics when the markers are hidden.
              role="list"
            >
              {eventRows.map((row) => {
                const fileCount =
                  row.kind === "event" ? (filesByEvent[row.id] ?? 0) : 0;
                return (
                  <li
                    key={row.id}
                    className={mergeClasses(
                      "person-timeline-item",
                      row.isLast && "person-timeline-item-last",
                    )}
                    // The type button stays the keyboard control; this is the
                    // mouse shortcut from the mockup, so it must not double-fire
                    // when the click starts on the button itself. A derived
                    // child-birth row has no event form to open.
                    onClick={(event) => {
                      const target = event.target as HTMLElement;
                      if (target.closest("button, a, input")) return;
                      if (row.kind !== "event") return;
                      openEvent({ entity: row.event, version: row.version });
                    }}
                  >
                    <span className="person-timeline-date">
                      {row.dateLabel}
                    </span>
                    <span
                      className="person-timeline-rail"
                      aria-hidden="true"
                    />
                    <span className="person-timeline-body">
                      <span className="person-timeline-head">
                        {row.kind === "event" ? (
                          <FluentButton
                            appearance="transparent"
                            className={mergeClasses(
                              styles.linkButton,
                              styles.eventTypeLink,
                            )}
                            title={t("event:editEvent")}
                            aria-label={`${t("event:editEvent")}: ${row.typeLabel}`}
                            onClick={() =>
                              openEvent({
                                entity: row.event,
                                version: row.version,
                              })
                            }
                          >
                            {row.typeLabel}
                          </FluentButton>
                        ) : (
                          <span className="person-timeline-type">
                            {row.typeLabel}
                          </span>
                        )}
                        {fileCount > 0 ? (
                          <span
                            className="person-timeline-files"
                            role="img"
                            aria-label={t("event:filesBadge", {
                              count: fileCount,
                            })}
                            title={t("event:filesBadge", {
                              count: fileCount,
                            })}
                          >
                            <AttachRegular aria-hidden="true" />
                            <span>{fileCount}</span>
                          </span>
                        ) : null}
                      </span>
                      {row.kind === "childBirth" ? (
                        <span className="person-timeline-child">
                          {onOpenPerson ? (
                            <FluentButton
                              appearance="transparent"
                              className={styles.linkButton}
                              aria-label={t("person:openChildBirth", {
                                name: row.childName,
                              })}
                              title={t("person:openChildBirth", {
                                name: row.childName,
                              })}
                              onClick={() => onOpenPerson(row.personId)}
                            >
                              {row.childName}
                            </FluentButton>
                          ) : (
                            <Text size={200}>{row.childName}</Text>
                          )}
                        </span>
                      ) : null}
                      {row.meta.length === 0 ? null : (
                        <span className="person-timeline-meta">
                          {row.meta.map((item) => (
                            <span key={item.key}>{item.text}</span>
                          ))}
                        </span>
                      )}
                      {row.description === null ? null : (
                        <span
                          className="person-timeline-note"
                          title={row.description}
                        >
                          {row.description}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </Section>

        <Section
          id="family"
          title={t("person:sections.family")}
          action={
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={openRelationshipForm}
            >
              + {t("relationship:add")}
            </Button>
          }
        >
          {hasRelationships ? (
            <Table size="small" className={styles.table}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t("relationship:type")}</TableHeaderCell>
                  <TableHeaderCell>
                    {t("relationship:relatedPerson")}
                  </TableHeaderCell>
                  <TableHeaderCell className={styles.actionsCell}>
                    {t("common:fields.actions")}
                  </TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.relationships.map((row) => {
                  const otherId = relatedPersonId(row.entity);
                  return (
                    <TableRow key={row.entity.id}>
                      <TableCell>
                        <TableCellLayout>
                          {t(
                            relationLabelKey(
                              row.entity.type,
                              relationDirection(row.entity, person.id),
                              relatedPerson(row.entity)?.gender ?? "UNKNOWN",
                            ),
                          )}
                        </TableCellLayout>
                      </TableCell>
                      <TableCell>
                        <TableCellLayout>
                          {onOpenPerson ? (
                            <FluentButton
                              appearance="transparent"
                              className={styles.linkButton}
                              onClick={() => onOpenPerson(otherId)}
                            >
                              {relatedName(row.entity)}
                            </FluentButton>
                          ) : (
                            relatedName(row.entity)
                          )}
                        </TableCellLayout>
                      </TableCell>
                      <TableCell className={styles.actionsCell}>
                        <MenuButton
                          label={t("common:actions.more")}
                          iconOnly
                          align="end"
                          items={[
                            {
                              id: "delete",
                              label: t("common:actions.delete"),
                              icon: <DeleteRegular aria-hidden="true" />,
                              danger: true,
                              disabled: saving,
                              onSelect: () => void removeRelationship(row),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState compact text={t("person:noRelationships")} />
          )}

          {relationshipFormOpen ? (
            <form className="person-relationship-form" onSubmit={addRelationship}>
              <Text as="h4" size={200} weight="semibold">
                {t("relationship:add")}
              </Text>
              <div className="person-relationship-fields">
                <Field
                  label={t("relationship:direction")}
                  htmlFor={`${relationshipFieldId}-role`}
                >
                  <Combobox
                    id={`${relationshipFieldId}-role`}
                    items={roleItems}
                    value={role}
                    onChange={(next) =>
                      setRole(
                        next === "" ? "parent" : (next as RelationshipRole),
                      )
                    }
                    placeholder={t("relationship:direction")}
                    ariaLabel={t("relationship:direction")}
                    emptyLabel={t("person:noMatches")}
                    disabled={saving}
                  />
                </Field>

                <Field
                  label={t("relationship:relatedPerson")}
                  htmlFor={`${relationshipFieldId}-related`}
                >
                  <Combobox
                    id={`${relationshipFieldId}-related`}
                    items={pickerItems}
                    value={relatedId}
                    onChange={setRelatedId}
                    placeholder={t("relationship:selectPerson")}
                    ariaLabel={t("relationship:relatedPerson")}
                    clearLabel={t("common:actions.clear")}
                    emptyLabel={t("person:noMatches")}
                    disabled={saving}
                  />
                </Field>
              </div>
              <div className="person-relationship-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={cancelRelationshipForm}
                >
                  {t("common:actions.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  disabled={saving || relatedId === ""}
                >
                  {t("relationship:add")}
                </Button>
              </div>
            </form>
          ) : null}
        </Section>

        {projectId ? (
          <Section id="kinship" title={t("person:sections.kinship")}>
            <KinshipPanel
              projectId={projectId}
              personId={person.id}
              persons={allPersons}
              homePersonId={homePersonId}
              onOpenPerson={onOpenPerson}
            />
          </Section>
        ) : null}

        <Section
          id="files"
          title={t("person:sections.files")}
          action={
            <Button
              variant="ghost"
              size="sm"
              disabled={attaching}
              onClick={attachMedia}
            >
              <AttachRegular aria-hidden="true" /> {t("person:attachMedia")}
            </Button>
          }
        >
          <ErrorBanner error={mediaError} />
          {mediaLoading ? (
            <div className="person-media-loading" aria-busy="true">
              <span className="skeleton" aria-hidden="true" />
              <span className="skeleton" aria-hidden="true" />
            </div>
          ) : media.length === 0 ? (
            <div className="person-media-empty">
              <EmptyState compact text={t("person:noMedia")} />
              <Button
                variant="secondary"
                size="sm"
                disabled={attaching}
                onClick={attachMedia}
              >
                <AttachRegular aria-hidden="true" /> {t("person:attachMedia")}
              </Button>
            </div>
          ) : (
            <div className="person-media">
              {images.length > 0 ? (
                <ul className="person-media-grid">
                  {images.map((item) => (
                    <li key={item.id}>
                      <div className="person-media-item">
                        <FluentButton
                          appearance="transparent"
                          className={styles.mediaThumb}
                          aria-label={t("person:openPhoto", {
                            name: mediaLabel(item),
                          })}
                          title={mediaLabel(item)}
                          onClick={() => setLightbox(item)}
                        >
                          <img
                            className={styles.mediaThumbImage}
                            src={convertFileSrc(item.path)}
                            alt={mediaLabel(item)}
                            loading="lazy"
                          />
                        </FluentButton>
                        {item.primary ? null : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="person-media-set-primary"
                            disabled={settingPrimary !== null}
                            onClick={() => makePrimary(item)}
                          >
                            <CameraRegular aria-hidden="true" />{" "}
                            {t("person:setProfilePhoto")}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              {documents.length > 0 ? (
                <ul className="plain person-media-files">
                  {documents.map((item) => (
                    <li key={item.id}>
                      <div className="person-media-file">
                        <DocumentRegular aria-hidden="true" />
                        <FluentButton
                          appearance="transparent"
                          className={styles.linkButton}
                          onClick={() => openMedia(item)}
                        >
                          <span className="person-media-file-name">
                            {mediaLabel(item)}
                          </span>
                        </FluentButton>
                        <Text
                          size={100}
                          className={mergeClasses("meta", styles.mutedText)}
                        >
                          {item.mimeType}
                        </Text>
                        <IconButton
                          label={t("person:openFile")}
                          onClick={() => openMedia(item)}
                        >
                          <OpenRegular aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={t("person:downloadFile")}
                          onClick={() => downloadMedia(item)}
                        >
                          <ArrowDownloadRegular aria-hidden="true" />
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </Section>
      </Accordion>

      {editingEvent ? (
        <EventForm
          initial={editingEvent.entity}
          version={editingEvent.version}
          persons={eventPersons}
          defaultPersonId={person.id}
          onSaved={() => {
            setEditingEvent(null);
            onChanged();
          }}
          onDeleted={() => {
            setEditingEvent(null);
            onChanged();
          }}
          onCancel={() => setEditingEvent(null)}
          onReload={onChanged}
          onFilesChanged={() => setMediaVersion((version) => version + 1)}
          onCreateRelated={(request) => {
            setEditingEvent(null);
            setCreateEventType(request.type);
            setOpenSections((current) => ({ ...current, events: true }));
            setCreatingEvent(true);
          }}
        />
      ) : null}

      {creatingEvent ? (
        <EventForm
          initial={null}
          version={null}
          persons={eventPersons}
          defaultPersonId={person.id}
          defaultType={createEventType}
          onSaved={() => {
            setCreatingEvent(false);
            setCreateEventType(undefined);
            onChanged();
          }}
          onCancel={() => {
            setCreatingEvent(false);
            setCreateEventType(undefined);
          }}
          onReload={onChanged}
        />
      ) : null}

      {lightbox ? (
        <div
          className="media-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t("person:photoViewer")}
          onClick={() => setLightbox(null)}
        >
          <div
            className="media-lightbox-frame"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="media-lightbox-head">
              <Text as="span" size={200} weight="semibold">
                {mediaLabel(lightbox)}
              </Text>
              <div className="actions">
                <IconButton
                  label={t("person:openFile")}
                  onClick={() => openMedia(lightbox)}
                >
                  <OpenRegular aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={t("person:downloadFile")}
                  onClick={() => downloadMedia(lightbox)}
                >
                  <ArrowDownloadRegular aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={t("person:closePhoto")}
                  onClick={() => setLightbox(null)}
                >
                  <DismissRegular aria-hidden="true" />
                </IconButton>
              </div>
            </div>
            <img src={convertFileSrc(lightbox.path)} alt={mediaLabel(lightbox)} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
