import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  Checkbox,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Select,
  Subtitle1,
  Switch,
  Text,
  Title2,
} from "@fluentui/react-components";
import { FolderOpenRegular } from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import {
  settingsApi,
  updatesApi,
  type SettingsPathKind,
} from "../../api/client";
import type { GeocoderProvider, MapBasemap, UpdateStatus } from "../../api/types";
import { Button } from "../../components/ui/button";
import { resolveLocale, setLocale } from "../../i18n";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { useAsyncAction } from "../../lib/useAsyncAction";
import { EVENT_TYPES } from "../events/helpers";
import type {
  CustomEventField,
  CustomEventFieldGroup,
} from "../events/fields";
import {
  appendCustomEventType,
  buildSettingsPatch,
  customEventTypeError,
  draftFromSnapshot,
  eventFieldGroupsError,
  formatWarnings,
  isHttpUrl,
  MAX_EVENT_FIELD_LABEL,
  MAX_EVENT_TYPE_NAME,
  nextEventFieldType,
  parseCount,
  removeCustomEventType,
  type Language,
  type SettingsDraft,
  type SettingsSnapshot,
  type Style,
  type Theme,
} from "./helpers";
import "./settings.css";

type Props = {
  /** Opens the built-in guide; the About block links to it. */
  onOpenHelp: () => void;
  /** Applies and caches the theme immediately; config is saved here too. */
  onThemeChange: (theme: Theme) => void;
  /** Applies and caches `app.style`; written by the shared Save button. */
  onStyleChange: (style: Style) => void;
};

/** Product constants, not translatable strings. */
const APP_NAME = "Gentree";
const APP_LICENSE = "MIT";

type SettingsSectionId =
  | "appearance"
  | "paths"
  | "backup"
  | "updates"
  | "eventTypes"
  | "eventFields"
  | "historical"
  | "map"
  | "chat"
  | "about";

/** Table of contents order; the active section is the only one rendered. */
const SETTINGS_SECTIONS: { id: SettingsSectionId; labelKey: string }[] = [
  { id: "appearance", labelKey: "settings:appearance" },
  { id: "paths", labelKey: "settings:paths" },
  { id: "backup", labelKey: "settings:backup" },
  { id: "updates", labelKey: "settings:updates" },
  { id: "eventTypes", labelKey: "settings:eventTypes" },
  { id: "eventFields", labelKey: "settings:eventFields" },
  { id: "historical", labelKey: "settings:historicalTitle" },
  { id: "map", labelKey: "settings:map" },
  { id: "chat", labelKey: "settings:chat" },
  { id: "about", labelKey: "settings:about" },
];

export default function SettingsPage({
  onOpenHelp,
  onThemeChange,
  onStyleChange,
}: Props) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>("appearance");
  const { busy, error, setError, run } = useAsyncAction();
  const [saved, setSaved] = useState(false);
  const [customTypeInput, setCustomTypeInput] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateAction, setUpdateAction] = useState<
    "checking" | "installing" | null
  >(null);
  const [updateError, setUpdateError] = useState<AppErrorEnvelope | null>(null);
  const [updateNotice, setUpdateNotice] = useState<
    "upToDate" | "installed" | null
  >(null);

  const applySnapshot = useCallback((next: SettingsSnapshot) => {
    setSnapshot(next);
    setDraft(draftFromSnapshot(next));
    setError(next.error);
    setSaved(false);
    onThemeChange(next.config.app.theme);
    onStyleChange(next.config.app.style);
  }, [onThemeChange, onStyleChange]);

  useEffect(() => {
    void run(async () => {
      applySnapshot(await invoke<SettingsSnapshot>("settings_get"));
    });
  }, [run, applySnapshot]);

  // The build and the installer read the same tauri.conf.json version, so the
  // About block shows the exact version that was installed.
  useEffect(() => {
    let active = true;
    getVersion()
      .then((value) => {
        if (active) setVersion(value);
      })
      .catch(() => {
        if (active) setVersion(null);
      });
    return () => {
      active = false;
    };
  }, []);

  // Facts only: this command reports the version and whether the build has a
  // real endpoint, and never contacts the update server.
  useEffect(() => {
    void updatesApi
      .status()
      .then(setUpdateStatus)
      .catch(() => setUpdateStatus(null));
  }, []);

  const update = useCallback((patch: Partial<SettingsDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  // Event types are persisted by the shared Save button; adding/removing only
  // changes the draft so Cancel still discards the edit.
  const addCustomType = () => {
    if (!draft) return;
    const next = appendCustomEventType(draft.customEventTypes, customTypeInput);
    if (next === null) return;
    update({ customEventTypes: next });
    setCustomTypeInput("");
  };

  const removeCustomType = (name: string) => {
    if (!draft) return;
    update({ customEventTypes: removeCustomEventType(draft.customEventTypes, name) });
  };

  const updateFieldGroups = (next: CustomEventFieldGroup[]) => {
    update({ eventFieldGroups: next });
  };

  const addFieldGroup = () => {
    if (!draft) return;
    updateFieldGroups([
      ...draft.eventFieldGroups,
      {
        type: nextEventFieldType(
          draft.eventFieldGroups,
          draft.customEventTypes,
          EVENT_TYPES,
        ),
        fields: [],
      },
    ]);
  };

  const updateFieldGroup = (
    index: number,
    patch: Partial<CustomEventFieldGroup>,
  ) => {
    if (!draft) return;
    updateFieldGroups(
      draft.eventFieldGroups.map((group, current) =>
        current === index ? { ...group, ...patch } : group,
      ),
    );
  };

  const removeFieldGroup = (index: number) => {
    if (!draft) return;
    updateFieldGroups(
      draft.eventFieldGroups.filter((_group, current) => current !== index),
    );
  };

  const addEventField = (groupIndex: number) => {
    if (!draft) return;
    const group = draft.eventFieldGroups[groupIndex];
    if (!group) return;
    updateFieldGroup(groupIndex, {
      fields: [...group.fields, { key: "", label: "", multiline: false }],
    });
  };

  const updateEventField = (
    groupIndex: number,
    fieldIndex: number,
    patch: Partial<CustomEventField>,
  ) => {
    if (!draft) return;
    const group = draft.eventFieldGroups[groupIndex];
    if (!group) return;
    updateFieldGroup(groupIndex, {
      fields: group.fields.map((field, current) =>
        current === fieldIndex ? { ...field, ...patch } : field,
      ),
    });
  };

  const removeEventField = (groupIndex: number, fieldIndex: number) => {
    if (!draft) return;
    const group = draft.eventFieldGroups[groupIndex];
    if (!group) return;
    updateFieldGroup(groupIndex, {
      fields: group.fields.filter((_field, current) => current !== fieldIndex),
    });
  };

  const reload = () =>
    run(async () => {
      applySnapshot(await invoke<SettingsSnapshot>("settings_reload"));
    });

  const save = () =>
    run(async () => {
      if (!snapshot || !draft) return;
      const patch = buildSettingsPatch(draft, snapshot.config);
      if (Object.keys(patch).length === 0) {
        setSaved(true);
        return;
      }
      applySnapshot(
        await invoke<SettingsSnapshot>("settings_update", { patch }),
      );
      setSaved(true);
      // ChatPage stays mounted while hidden and listens for this to refresh
      // its status without a restart.
      window.dispatchEvent(new Event("gentree:settings-saved"));
    });

  const changeLanguage = (language: Language) => {
    update({ language });
    void run(async () => {
      applySnapshot(
        await invoke<SettingsSnapshot>("settings_locale", { locale: language }),
      );
      await setLocale(resolveLocale(language, navigator.language));
    });
  };

  // The backend resolves the path from the config, so only the kind is sent.
  const openPath = (kind: SettingsPathKind) =>
    void run(async () => {
      await settingsApi.openPath(kind);
    });

  // The style changes the whole language, so it stays in the draft and is
  // applied once the snapshot comes back from the shared Save button.
  const changeStyle = (style: Style) => {
    update({ style });
    setSaved(false);
  };

  // The selected theme must be visible at once and survive a restart, so it is
  // applied locally, cached, and written to the config without waiting for Save.
  const changeTheme = (theme: Theme) => {
    update({ theme });
    onThemeChange(theme);
    void run(async () => {
      const next = await invoke<SettingsSnapshot>("settings_update", {
        patch: { app: { theme } },
      });
      setSnapshot(next);
      setError(next.error);
      setSaved(false);
    });
  };

  // Update checks are the only network actions on this screen. The backend
  // refuses a build with placeholder endpoint/pubkey, so the error stays local
  // and localized through `errors.<code>`.
  const checkForUpdates = () =>
    void (async () => {
      setUpdateBusy(true);
      setUpdateAction("checking");
      setUpdateError(null);
      setUpdateNotice(null);
      try {
        const next = await updatesApi.check();
        setUpdateStatus(next);
        if (!next.availableVersion) setUpdateNotice("upToDate");
      } catch (caught) {
        setUpdateError(normalizeError(caught));
      } finally {
        setUpdateBusy(false);
        setUpdateAction(null);
      }
    })();

  const installUpdate = () =>
    void (async () => {
      setUpdateBusy(true);
      setUpdateAction("installing");
      setUpdateError(null);
      setUpdateNotice(null);
      try {
        const next = await updatesApi.install();
        if (next.availableVersion) {
          // The version in `next` is now on disk; do not offer it again.
          setUpdateStatus({
            ...next,
            availableVersion: null,
            lastAutoCheck: null,
          });
          setUpdateNotice("installed");
        } else {
          setUpdateStatus(next);
          setUpdateNotice("upToDate");
        }
      } catch (caught) {
        setUpdateError(normalizeError(caught));
      } finally {
        setUpdateBusy(false);
        setUpdateAction(null);
      }
    })();

  if (!snapshot || !draft) {
    return (
      <section className="panel">
        <Text as="p">{t("settings:loading")}</Text>
      </section>
    );
  }

  const config = snapshot.config;
  const warnings = formatWarnings(snapshot.warnings);
  const countsValid =
    parseCount(draft.backupKeep) !== null && draft.backupKeep.trim() !== "";
  // DaData needs the name of the env var that holds the key; Photon does not.
  const geocoderUsesDadata = draft.geocoderProvider !== "photon";
  const geocoderValid =
    !draft.geocoderEnabled ||
    !geocoderUsesDadata ||
    draft.geocoderApiKeyEnv.trim() !== "";
  const mapValid = isHttpUrl(draft.mapTileUrl);

  const customTypeError =
    customTypeInput.trim() === ""
      ? null
      : customEventTypeError(draft.customEventTypes, customTypeInput);
  const addCustomTypeDisabled = busy || customTypeError !== null;

  const fieldGroupsError = eventFieldGroupsError(draft.eventFieldGroups);

  const autoCheck = updateStatus?.lastAutoCheck ?? null;
  // An automatic check may have found a release before this screen opened;
  // its version is still installable because install re-checks first.
  const availableUpdate =
    updateStatus?.availableVersion ?? autoCheck?.availableVersion ?? null;

  // A path row keeps the existing label/value line and adds one compact button;
  // the fixed first column keeps every folder icon on the same left edge.
  const pathRow = (kind: SettingsPathKind, label: string, value: string) => (
    <div
      className="settings-path"
      style={{
        display: "grid",
        gridTemplateColumns: "28px minmax(0, 1fr)",
        alignItems: "center",
        columnGap: 8,
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("settings:openPath")}
        title={t("settings:openPath")}
        disabled={busy}
        style={{ minWidth: 28, width: 28, height: 28, padding: 0 }}
        onClick={() => openPath(kind)}
      >
        <FolderOpenRegular fontSize={16} aria-hidden="true" />
      </Button>
      <Text as="p" size={200} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {label}: <code>{value}</code>
      </Text>
    </div>
  );

  return (
    <div className="settings-page">
      <section className="panel">
        <Title2 as="h1">{t("settings:title")}</Title2>
        <div className="actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={reload}
          >
            {t("settings:reload")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={
              busy ||
              !countsValid ||
              !geocoderValid ||
              !mapValid ||
              fieldGroupsError !== null
            }
            onClick={save}
          >
            {t("settings:save")}
          </Button>
        </div>
        {saved ? (
          <MessageBar intent="success" politeness="polite">
            <MessageBarBody>{t("settings:saved")}</MessageBarBody>
          </MessageBar>
        ) : null}
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>
              {t(`errors.${error.code}`, {
                defaultValue: t("errors.UNKNOWN"),
              })}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {warnings.length > 0 ? (
          <MessageBar intent="warning" politeness="polite">
            <MessageBarBody>
              <MessageBarTitle>{t("settings:warnings")}</MessageBarTitle>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </MessageBarBody>
          </MessageBar>
        ) : null}
      </section>

      <nav className="settings-nav" aria-label={t("settings:tocLabel")}>
        {SETTINGS_SECTIONS.map((section) => (
          <Button
            key={section.id}
            variant="ghost"
            size="sm"
            className="settings-nav-item"
            aria-current={activeSection === section.id ? "page" : undefined}
            onClick={() => setActiveSection(section.id)}
          >
            {t(section.labelKey)}
          </Button>
        ))}
      </nav>

      <section className="panel" hidden={activeSection !== "appearance"}>
        <Subtitle1 as="h2">{t("settings:appearance")}</Subtitle1>
        <Field
          label={{
            children: t("settings:language"),
            htmlFor: "settings-language",
          }}
        >
          <Select
            id="settings-language"
            value={draft.language}
            disabled={busy}
            onChange={(event) =>
              changeLanguage(event.target.value as Language)
            }
          >
            <option value="system">{t("settings:languageSystem")}</option>
            <option value="ru">{t("settings:languageRu")}</option>
            <option value="en">{t("settings:languageEn")}</option>
            <option value="uk">{t("settings:languageUk")}</option>
            <option value="be">{t("settings:languageBe")}</option>
            <option value="de">{t("settings:languageDe")}</option>
            <option value="es">{t("settings:languageEs")}</option>
          </Select>
        </Field>
        <Field
          label={{ children: t("settings:theme"), htmlFor: "settings-theme" }}
        >
          <Select
            id="settings-theme"
            value={draft.theme}
            disabled={busy}
            onChange={(event) => changeTheme(event.target.value as Theme)}
          >
            <option value="system">{t("settings:themeSystem")}</option>
            <option value="light">{t("settings:themeLight")}</option>
            <option value="dark">{t("settings:themeDark")}</option>
          </Select>
        </Field>
        <Text as="p" size={200}>
          {t("settings:themeHint")}
        </Text>
        <Field
          label={{ children: t("settings:style"), htmlFor: "settings-style" }}
        >
          <Select
            id="settings-style"
            value={draft.style}
            disabled={busy}
            onChange={(event) => changeStyle(event.target.value as Style)}
          >
            <option value="classic">{t("settings:styleClassic")}</option>
            <option value="swiss">{t("settings:styleSwiss")}</option>
          </Select>
        </Field>
        <Text as="p" size={200}>
          {t("settings:styleHint")}
        </Text>
        <Checkbox
          label={t("settings:graphWholeTree")}
          checked={draft.graphWholeTree === true}
          disabled={busy}
          onChange={(_event, data) =>
            update({ graphWholeTree: data.checked === true })
          }
        />
        <Text as="p" size={200}>
          {t("settings:graphWholeTreeHint")}
        </Text>
      </section>

      <section className="panel" hidden={activeSection !== "eventTypes"}>
        <Subtitle1 as="h2">{t("settings:eventTypes")}</Subtitle1>
        <Text as="p" size={200}>
          {t("settings:eventTypesHint")}
        </Text>
        <ul style={{ margin: "4px 0 0", paddingInlineStart: 20 }}>
          {EVENT_TYPES.map((type) => (
            <li key={type}>
              <Text size={200}>{t(`enums:eventType.${type}`)}</Text>
            </li>
          ))}
        </ul>
        {draft.customEventTypes.length === 0 ? (
          <Text as="p" size={200} style={{ opacity: 0.8 }}>
            {t("settings:eventTypesEmpty")}
          </Text>
        ) : (
          <ul style={{ margin: "4px 0 0", paddingInlineStart: 20 }}>
            {draft.customEventTypes.map((name) => (
              <li
                key={name}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <Text size={200}>{name}</Text>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t("settings:eventTypeRemove", { name })}
                  title={t("settings:eventTypeRemove", { name })}
                  style={{ minWidth: 24, width: 24, height: 24, padding: 0 }}
                  onClick={() => removeCustomType(name)}
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            alignItems: "start",
            columnGap: 8,
            marginTop: 8,
          }}
        >
          <Input
            id="settings-event-type-new"
            value={customTypeInput}
            maxLength={MAX_EVENT_TYPE_NAME}
            placeholder={t("settings:eventTypePlaceholder")}
            aria-label={t("settings:eventTypePlaceholder")}
            disabled={busy}
            onChange={(_, data) => setCustomTypeInput(data.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustomType();
              }
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={addCustomTypeDisabled}
            onClick={addCustomType}
          >
            {t("settings:eventTypeAdd")}
          </Button>
        </div>
        {customTypeError === "duplicate" ? (
          <Text as="p" size={200} className="error">
            {t("settings:eventTypeDuplicate")}
          </Text>
        ) : null}
      </section>

      <section className="panel" hidden={activeSection !== "eventFields"}>
        <Subtitle1 as="h2">{t("settings:eventFields")}</Subtitle1>
        <Text as="p" size={200}>
          {t("settings:eventFieldsHint")}
        </Text>
        <Text
          as="p"
          id="settings-event-fields-key-hint"
          size={200}
          className="settings-event-field-key-hint"
        >
          {t("settings:eventFieldKeyHint")}
        </Text>
        {draft.eventFieldGroups.length === 0 ? (
          <Text as="p" size={200} style={{ opacity: 0.8 }}>
            {t("settings:eventFieldsEmpty")}
          </Text>
        ) : null}
        {draft.eventFieldGroups.map((group, groupIndex) => {
          const typeOptions = [...EVENT_TYPES, ...draft.customEventTypes];
          if (group.type !== "" && !typeOptions.includes(group.type)) {
            typeOptions.push(group.type);
          }
          return (
            <div
              key={groupIndex}
              style={{
                display: "grid",
                gap: 8,
                marginTop: 8,
                padding: 8,
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control, 6px)",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  alignItems: "end",
                  gap: 8,
                }}
              >
                <Field
                  label={{
                    children: t("settings:eventFieldType"),
                    htmlFor: `settings-field-group-type-${groupIndex}`,
                  }}
                >
                  <Select
                    id={`settings-field-group-type-${groupIndex}`}
                    value={group.type}
                    disabled={busy}
                    onChange={(event) =>
                      updateFieldGroup(groupIndex, {
                        type: event.target.value,
                      })
                    }
                  >
                    {group.type === "" ? (
                      <option value="">
                        {t("settings:eventFieldTypePlaceholder")}
                      </option>
                    ) : null}
                    {EVENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`enums:eventType.${type}`)}
                      </option>
                    ))}
                    {draft.customEventTypes.map((name) => (
                      <option key={`custom:${name}`} value={name}>
                        {name}
                      </option>
                    ))}
                    {group.type !== "" && !(EVENT_TYPES as readonly string[]).includes(group.type) &&
                    !draft.customEventTypes.includes(group.type) ? (
                      <option value={group.type}>{group.type}</option>
                    ) : null}
                  </Select>
                </Field>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => removeFieldGroup(groupIndex)}
                >
                  {t("settings:eventFieldGroupRemove")}
                </Button>
              </div>

              {group.fields.map((field, fieldIndex) => (
                <div key={fieldIndex} className="settings-event-field-row">
                  <Field
                    label={{
                      children: t("settings:eventFieldKey"),
                      htmlFor: `settings-field-key-${groupIndex}-${fieldIndex}`,
                    }}
                  >
                    <Input
                      id={`settings-field-key-${groupIndex}-${fieldIndex}`}
                      value={field.key}
                      placeholder="military_rank"
                      aria-describedby="settings-event-fields-key-hint"
                      disabled={busy}
                      onChange={(_event, data) =>
                        updateEventField(groupIndex, fieldIndex, {
                          key: data.value,
                        })
                      }
                    />
                  </Field>
                  <Field
                    label={{
                      children: t("settings:eventFieldLabel"),
                      htmlFor: `settings-field-label-${groupIndex}-${fieldIndex}`,
                    }}
                  >
                    <Input
                      id={`settings-field-label-${groupIndex}-${fieldIndex}`}
                      value={field.label}
                      maxLength={MAX_EVENT_FIELD_LABEL}
                      disabled={busy}
                      onChange={(_event, data) =>
                        updateEventField(groupIndex, fieldIndex, {
                          label: data.value,
                        })
                      }
                    />
                  </Field>
                  <div className="settings-event-field-controls">
                    <Checkbox
                      label={t("settings:eventFieldMultiline")}
                      checked={field.multiline === true}
                      disabled={busy}
                      onChange={(_event, data) =>
                        updateEventField(groupIndex, fieldIndex, {
                          multiline: data.checked === true,
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={t("settings:eventFieldRemove")}
                      title={t("settings:eventFieldRemove")}
                      onClick={() => removeEventField(groupIndex, fieldIndex)}
                    >
                      ×
                    </Button>
                  </div>
                </div>
              ))}

              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => addEventField(groupIndex)}
                >
                  {t("settings:eventFieldAdd")}
                </Button>
              </div>
            </div>
          );
        })}
        <div style={{ marginTop: 8 }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={addFieldGroup}
          >
            {t("settings:eventFieldGroupAdd")}
          </Button>
        </div>
        {fieldGroupsError ? (
          <Text as="p" size={200} className="error">
            {t("settings:eventFieldsInvalid")}
          </Text>
        ) : null}
      </section>

      <section className="panel" hidden={activeSection !== "historical"}>
        <Subtitle1 as="h2">{t("settings:historicalTitle")}</Subtitle1>
        <Switch
          label={t("settings:historicalEnabled")}
          checked={draft.historicalEnabled}
          onChange={(_, data) => update({ historicalEnabled: data.checked })}
        />
        <Text as="p" size={200}>
          {t("settings:historicalHint")}
        </Text>
      </section>

      <section className="panel" hidden={activeSection !== "map"}>
        <Subtitle1 as="h2">{t("settings:map")}</Subtitle1>
        <Field
          label={{
            children: t("settings:mapBasemap"),
            htmlFor: "settings-map-basemap",
          }}
        >
          <Select
            id="settings-map-basemap"
            value={draft.mapBasemap}
            disabled={busy}
            onChange={(event) =>
              update({ mapBasemap: event.target.value as MapBasemap })
            }
          >
            <option value="osm">{t("settings:mapBasemapOsm")}</option>
            <option value="offline">{t("settings:mapBasemapOffline")}</option>
          </Select>
        </Field>
        <Field
          label={{
            children: t("settings:mapTileUrl"),
            htmlFor: "settings-map-tile-url",
          }}
          hint={t("settings:mapTileUrlHint")}
        >
          <Input
            id="settings-map-tile-url"
            value={draft.mapTileUrl}
            disabled={busy}
            onChange={(_, data) => update({ mapTileUrl: data.value })}
          />
        </Field>
        {!mapValid ? (
          <Text as="p" size={200} className="error">
            {t("settings:mapTileUrlInvalid")}
          </Text>
        ) : null}
        <Subtitle1 as="h2">{t("settings:geocoder")}</Subtitle1>
        <Switch
          label={t("settings:geocoderEnabled")}
          checked={draft.geocoderEnabled}
          onChange={(_, data) => update({ geocoderEnabled: data.checked })}
        />
        <Text as="p" size={200}>
          {t("settings:geocoderHint")}
        </Text>
        {draft.geocoderEnabled ? (
          <>
            <Field
              label={{
                children: t("settings:geocoderProvider"),
                htmlFor: "settings-geocoder-provider",
              }}
            >
              <Select
                id="settings-geocoder-provider"
                value={draft.geocoderProvider}
                disabled={busy}
                onChange={(event) =>
                  update({
                    geocoderProvider: event.target.value as GeocoderProvider,
                  })
                }
              >
                <option value="both">
                  {t("settings:geocoderProviderBoth")}
                </option>
                <option value="photon">
                  {t("settings:geocoderProviderPhoton")}
                </option>
                <option value="dadata">
                  {t("settings:geocoderProviderDadata")}
                </option>
              </Select>
            </Field>
            {geocoderUsesDadata ? (
              <>
                <Field
                  label={{
                    children: t("settings:geocoderApiKeyEnv"),
                    htmlFor: "settings-geocoder-api-key-env",
                  }}
                  hint={t("settings:geocoderApiKeyHint")}
                >
                  <Input
                    id="settings-geocoder-api-key-env"
                    value={draft.geocoderApiKeyEnv}
                    disabled={busy}
                    onChange={(_, data) =>
                      update({ geocoderApiKeyEnv: data.value })
                    }
                  />
                </Field>
                {!snapshot.geocoderApiKeyPresent ? (
                  <MessageBar intent="warning" politeness="polite">
                    <MessageBarBody>
                      {t(
                        draft.geocoderProvider === "dadata"
                          ? "settings:geocoderApiKeyMissingDadata"
                          : "settings:geocoderApiKeyMissing",
                      )}
                    </MessageBarBody>
                  </MessageBar>
                ) : null}
              </>
            ) : null}
            <MessageBar intent="warning" politeness="polite">
              <MessageBarBody>{t("settings:geocoderPrivacy")}</MessageBarBody>
            </MessageBar>
          </>
        ) : null}
      </section>

      <section className="panel" hidden={activeSection !== "paths"}>
        <Subtitle1 as="h2">{t("settings:paths")}</Subtitle1>
        {pathRow(
          "projects",
          t("settings:projectsDir"),
          config.storage.projects_dir,
        )}
        {pathRow(
          "backups",
          t("settings:backupsDir"),
          config.storage.backups_dir,
        )}
        {pathRow("index", t("settings:indexDir"), config.search.index_dir)}
        {pathRow("config", t("settings:configFile"), snapshot.configPath)}
      </section>

      <section className="panel" hidden={activeSection !== "chat"}>
        <Subtitle1 as="h2">{t("settings:chat")}</Subtitle1>
        <Switch
          label={t("settings:chatEnabled")}
          checked={draft.chatEnabled}
          onChange={(_, data) => update({ chatEnabled: data.checked })}
        />
        <Field
          label={{
            children: t("settings:chatBaseUrl"),
            htmlFor: "settings-chat-base-url",
          }}
        >
          <Input
            id="settings-chat-base-url"
            value={draft.chatBaseUrl}
            onChange={(_, data) => update({ chatBaseUrl: data.value })}
          />
        </Field>
        <Field
          label={{
            children: t("settings:chatModel"),
            htmlFor: "settings-chat-model",
          }}
        >
          <Input
            id="settings-chat-model"
            value={draft.chatModel}
            onChange={(_, data) => update({ chatModel: data.value })}
          />
        </Field>
        <Field
          label={{
            children: t("settings:chatApiKeyEnv"),
            htmlFor: "settings-chat-api-key-env",
          }}
        >
          <Input
            id="settings-chat-api-key-env"
            value={draft.chatApiKeyEnv}
            onChange={(_, data) => update({ chatApiKeyEnv: data.value })}
          />
        </Field>
        <Text as="p" size={200}>
          {snapshot.chatApiKeyPresent
            ? t("settings:chatApiKeyFound")
            : t("settings:chatApiKeyMissing")}
        </Text>
        <Checkbox
          label={t("settings:chatShowTools")}
          checked={draft.chatShowTools}
          onChange={(_, data) => update({ chatShowTools: data.checked === true })}
        />
        <Text as="p" size={200}>
          {t("settings:chatShowToolsHint")}
        </Text>
        <Switch
          label={t("settings:chatAllowPersonEdits")}
          checked={draft.chatAllowPersonEdits}
          onChange={(_, data) => update({ chatAllowPersonEdits: data.checked })}
        />
        <Text as="p" size={200}>
          {t("settings:chatAllowPersonEditsHint")}
        </Text>
      </section>

      <section className="panel" hidden={activeSection !== "backup"}>
        <Subtitle1 as="h2">{t("settings:backup")}</Subtitle1>
        <Field
          label={{
            children: t("settings:backupKeep"),
            htmlFor: "settings-backup-keep",
          }}
        >
          <Input
            id="settings-backup-keep"
            type="number"
            min={1}
            value={draft.backupKeep}
            onChange={(_, data) => update({ backupKeep: data.value })}
          />
        </Field>
      </section>

      <section className="panel" hidden={activeSection !== "updates"}>
        <Subtitle1 as="h2">{t("settings:updates")}</Subtitle1>
        {updateStatus ? (
          <Text as="p" size={200}>
            {t("settings:updatesCurrentVersion", {
              version: updateStatus.currentVersion,
            })}
          </Text>
        ) : null}
        {updateStatus && !updateStatus.configured ? (
          <MessageBar intent="warning" politeness="polite">
            <MessageBarBody>
              {t("settings:updatesNotConfigured")}{" "}
              {t("settings:updatesNotConfiguredHint")}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        <Switch
          label={t("settings:updatesAutoCheck")}
          checked={draft.updatesAutoCheck}
          onChange={(_, data) =>
            update({ updatesAutoCheck: data.checked === true })
          }
        />
        <Text as="p" size={200}>
          {t("settings:updatesAutoCheckHint")}
        </Text>
        <div className="actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || updateBusy}
            onClick={checkForUpdates}
          >
            {updateAction === "checking"
              ? t("settings:updatesChecking")
              : t("settings:updatesCheck")}
          </Button>
          {availableUpdate ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={busy || updateBusy}
              onClick={installUpdate}
            >
              {updateAction === "installing"
                ? t("settings:updatesInstalling")
                : t("settings:updatesInstall")}
            </Button>
          ) : null}
        </div>
        {updateError ? (
          <MessageBar intent="error">
            <MessageBarBody>
              {t(`errors.${updateError.code}`, {
                defaultValue: t("errors.UNKNOWN"),
              })}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {updateNotice === "upToDate" ? (
          <MessageBar intent="success" politeness="polite">
            <MessageBarBody>{t("settings:updatesUpToDate")}</MessageBarBody>
          </MessageBar>
        ) : null}
        {updateNotice === "installed" ? (
          <MessageBar intent="success" politeness="polite">
            <MessageBarBody>{t("settings:updatesInstalled")}</MessageBarBody>
          </MessageBar>
        ) : null}
        {availableUpdate ? (
          <MessageBar intent="info" politeness="polite">
            <MessageBarBody>
              <div>
                {t("settings:updatesAvailable", { version: availableUpdate })}
              </div>
              {updateStatus?.notes ? (
                <div style={{ whiteSpace: "pre-wrap" }}>
                  <strong>{t("settings:updatesNotes")}:</strong>{" "}
                  {updateStatus.notes}
                </div>
              ) : null}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {autoCheck ? (
          <>
            <Text as="p" size={200}>
              {t("settings:updatesLastAutoCheck", { date: autoCheck.checkedAt })}
            </Text>
            {autoCheck.availableVersion ? (
              <Text as="p" size={200}>
                {t("settings:updatesAutoCheckAvailable", {
                  version: autoCheck.availableVersion,
                })}
              </Text>
            ) : null}
            {autoCheck.errorCode ? (
              <MessageBar intent="warning" politeness="polite">
                <MessageBarBody>
                  {t("settings:updatesAutoCheckFailed")}
                </MessageBarBody>
              </MessageBar>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="panel" hidden={activeSection !== "about"}>
        <Subtitle1 as="h2">{t("settings:about")}</Subtitle1>
        <dl className="facts">
          <dt>{t("settings:aboutApp")}</dt>
          <dd>{APP_NAME}</dd>
          <dt>{t("settings:aboutVersion")}</dt>
          <dd>
            {version === undefined
              ? ""
              : (version ?? t("settings:aboutVersionUnknown"))}
          </dd>
          <dt>{t("settings:aboutLicense")}</dt>
          <dd>{APP_LICENSE}</dd>
        </dl>
        <Text as="p" size={200}>
          {t("settings:aboutPrivacy")}
        </Text>
        <Button variant="secondary" onClick={onOpenHelp}>
          {t("settings:openHelp")}
        </Button>
      </section>
    </div>
  );
}
