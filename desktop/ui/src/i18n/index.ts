import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ru from "./locales/ru/common.json";
import en from "./locales/en/common.json";
import ruSettings from "./locales/ru/settings.json";
import enSettings from "./locales/en/settings.json";
import ruProject from "./locales/ru/project.json";
import enProject from "./locales/en/project.json";
import ruPerson from "./locales/ru/person.json";
import enPerson from "./locales/en/person.json";
import ruEvent from "./locales/ru/event.json";
import enEvent from "./locales/en/event.json";
import ruSearch from "./locales/ru/search.json";
import enSearch from "./locales/en/search.json";
import ruRelationship from "./locales/ru/relationship.json";
import enRelationship from "./locales/en/relationship.json";
import ruGraph from "./locales/ru/graph.json";
import enGraph from "./locales/en/graph.json";
import ruPath from "./locales/ru/path.json";
import enPath from "./locales/en/path.json";
import ruTimeline from "./locales/ru/timeline.json";
import ruMap from "./locales/ru/map.json";
import enTimeline from "./locales/en/timeline.json";
import enMap from "./locales/en/map.json";
import ruChat from "./locales/ru/chat.json";
import enChat from "./locales/en/chat.json";
import ruKinship from "./locales/ru/kinship.json";
import enKinship from "./locales/en/kinship.json";
import ruImport from "./locales/ru/import.json";
import enImport from "./locales/en/import.json";
import ruEnums from "./locales/ru/enums.json";
import enEnums from "./locales/en/enums.json";
import ukCommon from "./locales/uk/common.json";
import ukSettings from "./locales/uk/settings.json";
import ukProject from "./locales/uk/project.json";
import ukPerson from "./locales/uk/person.json";
import ukEvent from "./locales/uk/event.json";
import ukSearch from "./locales/uk/search.json";
import ukRelationship from "./locales/uk/relationship.json";
import ukGraph from "./locales/uk/graph.json";
import ukPath from "./locales/uk/path.json";
import ukTimeline from "./locales/uk/timeline.json";
import ukMap from "./locales/uk/map.json";
import ukChat from "./locales/uk/chat.json";
import ukKinship from "./locales/uk/kinship.json";
import ukImport from "./locales/uk/import.json";
import ukEnums from "./locales/uk/enums.json";
import beCommon from "./locales/be/common.json";
import beSettings from "./locales/be/settings.json";
import beProject from "./locales/be/project.json";
import bePerson from "./locales/be/person.json";
import beEvent from "./locales/be/event.json";
import beSearch from "./locales/be/search.json";
import beRelationship from "./locales/be/relationship.json";
import beGraph from "./locales/be/graph.json";
import bePath from "./locales/be/path.json";
import beTimeline from "./locales/be/timeline.json";
import beMap from "./locales/be/map.json";
import beChat from "./locales/be/chat.json";
import beKinship from "./locales/be/kinship.json";
import beImport from "./locales/be/import.json";
import beEnums from "./locales/be/enums.json";
import deCommon from "./locales/de/common.json";
import deSettings from "./locales/de/settings.json";
import deProject from "./locales/de/project.json";
import dePerson from "./locales/de/person.json";
import deEvent from "./locales/de/event.json";
import deSearch from "./locales/de/search.json";
import deRelationship from "./locales/de/relationship.json";
import deGraph from "./locales/de/graph.json";
import dePath from "./locales/de/path.json";
import deTimeline from "./locales/de/timeline.json";
import deMap from "./locales/de/map.json";
import deChat from "./locales/de/chat.json";
import deKinship from "./locales/de/kinship.json";
import deImport from "./locales/de/import.json";
import deEnums from "./locales/de/enums.json";
import esCommon from "./locales/es/common.json";
import esSettings from "./locales/es/settings.json";
import esProject from "./locales/es/project.json";
import esPerson from "./locales/es/person.json";
import esEvent from "./locales/es/event.json";
import esSearch from "./locales/es/search.json";
import esRelationship from "./locales/es/relationship.json";
import esGraph from "./locales/es/graph.json";
import esPath from "./locales/es/path.json";
import esTimeline from "./locales/es/timeline.json";
import esMap from "./locales/es/map.json";
import esChat from "./locales/es/chat.json";
import esKinship from "./locales/es/kinship.json";
import esImport from "./locales/es/import.json";
import esEnums from "./locales/es/enums.json";
import ruHelp from "./locales/ru/help.json";
import enHelp from "./locales/en/help.json";
import ukHelp from "./locales/uk/help.json";
import beHelp from "./locales/be/help.json";
import deHelp from "./locales/de/help.json";
import esHelp from "./locales/es/help.json";
import ruOnboarding from "./locales/ru/onboarding.json";
import enOnboarding from "./locales/en/onboarding.json";
import ukOnboarding from "./locales/uk/onboarding.json";
import beOnboarding from "./locales/be/onboarding.json";
import deOnboarding from "./locales/de/onboarding.json";
import esOnboarding from "./locales/es/onboarding.json";
import { resolveLocale, type Locale } from "./locale";

export { SUPPORTED_LOCALES, resolveLocale, errorMessageKey } from "./locale";
export type { Locale } from "./locale";

const initial = resolveLocale(
  localStorage.getItem("gentree.locale"),
  navigator.language,
);

void i18n.use(initReactI18next).init({
  resources: {
    ru: {
      common: ru,
      settings: ruSettings,
      project: ruProject,
      person: ruPerson,
      event: ruEvent,
      search: ruSearch,
      relationship: ruRelationship,
      graph: ruGraph,
      path: ruPath,
      timeline: ruTimeline,
      map: ruMap,
      chat: ruChat,
      kinship: ruKinship,
      import: ruImport,
      enums: ruEnums,
      help: ruHelp,
      onboarding: ruOnboarding,
    },
    en: {
      common: en,
      settings: enSettings,
      project: enProject,
      person: enPerson,
      event: enEvent,
      search: enSearch,
      relationship: enRelationship,
      graph: enGraph,
      path: enPath,
      timeline: enTimeline,
      map: enMap,
      chat: enChat,
      kinship: enKinship,
      import: enImport,
      enums: enEnums,
      help: enHelp,
      onboarding: enOnboarding,
    },
    uk: {
      common: ukCommon,
      settings: ukSettings,
      project: ukProject,
      person: ukPerson,
      event: ukEvent,
      search: ukSearch,
      relationship: ukRelationship,
      graph: ukGraph,
      path: ukPath,
      timeline: ukTimeline,
      map: ukMap,
      chat: ukChat,
      kinship: ukKinship,
      import: ukImport,
      enums: ukEnums,
      help: ukHelp,
      onboarding: ukOnboarding,
    },
    be: {
      common: beCommon,
      settings: beSettings,
      project: beProject,
      person: bePerson,
      event: beEvent,
      search: beSearch,
      relationship: beRelationship,
      graph: beGraph,
      path: bePath,
      timeline: beTimeline,
      map: beMap,
      chat: beChat,
      kinship: beKinship,
      import: beImport,
      enums: beEnums,
      help: beHelp,
      onboarding: beOnboarding,
    },
    de: {
      common: deCommon,
      settings: deSettings,
      project: deProject,
      person: dePerson,
      event: deEvent,
      search: deSearch,
      relationship: deRelationship,
      graph: deGraph,
      path: dePath,
      timeline: deTimeline,
      map: deMap,
      chat: deChat,
      kinship: deKinship,
      import: deImport,
      enums: deEnums,
      help: deHelp,
      onboarding: deOnboarding,
    },
    es: {
      common: esCommon,
      settings: esSettings,
      project: esProject,
      person: esPerson,
      event: esEvent,
      search: esSearch,
      relationship: esRelationship,
      graph: esGraph,
      path: esPath,
      timeline: esTimeline,
      map: esMap,
      chat: esChat,
      kinship: esKinship,
      import: esImport,
      enums: esEnums,
      help: esHelp,
      onboarding: esOnboarding,
    },
  },
  lng: initial,
  fallbackLng: "ru",
  defaultNS: "common",
  ns: [
    "common",
    "settings",
    "project",
    "person",
    "event",
    "search",
    "relationship",
    "graph",
    "path",
    "timeline",
    "chat",
    "kinship",
    "import",
    "enums",
    "help",
    "onboarding",
  ],
  interpolation: { escapeValue: false },
});

document.documentElement.lang = initial;

export async function setLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  localStorage.setItem("gentree.locale", locale);
  document.documentElement.lang = locale;
}

export default i18n;
