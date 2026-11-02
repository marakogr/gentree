// Generates a deterministic, fully synthetic demo project for screenshots and
// manual tours. No real names, dates or places are used.
//
//   node scripts/make-demo-project.mjs [output-dir]
//
// The output is one project folder whose name is the project id, ready to be
// copied into `<app data>/projects/` (or opened by the isolated UX run).

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const OUT =
  process.argv[2] ??
  path.join("desktop", "ui", "e2e", ".cache", "demo-project");

const PROJECT_ID = "d3e00000-0000-4000-8000-000000000001";
const HOME_PERSON = "00000000-0000-4000-8000-000000000009";

function id(prefix, n) {
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const personId = (n) => id("00000000", n);
const eventId = (n) => id("10000000", n);
const relationshipId = (n) => id("20000000", n);
const sourceId = (n) => id("30000000", n);
const citationId = (n) => id("40000000", n);

const UNKNOWN = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

function day(iso, qualifier = "EXACT") {
  const [year, month, date] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  const end = next.toISOString().slice(0, 10);
  return { start: iso, end, precision: "DAY", qualifier, original: null };
}

function year(value, qualifier = "EXACT") {
  return {
    start: `${value}-01-01`,
    end: `${value + 1}-01-01`,
    precision: "YEAR",
    qualifier,
    original: null,
  };
}

function unknown(original) {
  return { ...UNKNOWN, original };
}

function name(surname, given, patronymic, extra = {}) {
  return {
    given,
    patronymic,
    surname,
    prefix: null,
    suffix: null,
    nameType: "BIRTH",
    isPrimary: true,
    ...extra,
  };
}

// Confirmed points for the demo map. Every place text used below has an entry
// or a city fallback, so the Map tab shows the same synthetic settlements that
// the table and timeline mention. Coordinates are approximate city centres.
const CITY_POINTS = {
  "Казань": { lat: 55.7963, lon: 49.1088 },
  "Москва": { lat: 55.7558, lon: 37.6173 },
  "Санкт-Петербург": { lat: 59.9343, lon: 30.3351 },
};
const PLACE_POINTS = {
  "Казань, Большая Проломная улица": { lat: 55.7879, lon: 49.1211 },
  "Казань, улица Горького": { lat: 55.79, lon: 49.12 },
  "Казань, Арское кладбище": { lat: 55.8064, lon: 49.1731 },
  "Москва, район Хамовники": { lat: 55.7304, lon: 37.5794 },
  "Москва, Троекуровское кладбище": { lat: 55.7011, lon: 37.3992 },
};
const REGION_POINTS = {
  "Брянская область": { lat: 52.9, lon: 33.5 },
};

function placeGeo(place) {
  if (!place) return undefined;
  const exact = PLACE_POINTS[place];
  if (exact) {
    return {
      ...exact,
      precision: "POINT",
      source: "MANUAL",
      providerRef: null,
      label: place,
    };
  }
  const region = REGION_POINTS[place];
  if (region) {
    return {
      ...region,
      precision: "REGION",
      source: "MANUAL",
      providerRef: null,
      label: place,
    };
  }
  const city =
    CITY_POINTS[place] ??
    Object.entries(CITY_POINTS).find(([name]) => place.startsWith(`${name},`))?.[1];
  if (!city) return undefined;
  return {
    ...city,
    precision: "SETTLEMENT",
    source: "MANUAL",
    providerRef: null,
    label: place,
  };
}

const people = [
  {
    n: 1,
    gender: "MALE",
    names: [name("Волков", "Пётр", "Ильич")],
    birth: year(1898, "APPROXIMATE"),
    death: day("1974-11-02"),
    notes: "Столяр, переехал в Казань перед Первой мировой войной.",
  },
  {
    n: 2,
    gender: "FEMALE",
    names: [
      name("Соколова", "Анна", "Михайловна"),
      {
        given: "Анна",
        patronymic: "Михайловна",
        surname: "Волкова",
        prefix: null,
        suffix: null,
        nameType: "MARRIED",
        isPrimary: false,
      },
    ],
    birth: day("1901-06-23"),
    death: day("1985-02-17"),
    notes: null,
  },
  {
    n: 3,
    gender: "MALE",
    names: [name("Лебедев", "Николай", "Андреевич")],
    birth: year(1895),
    death: day("1943-01-12"),
    notes: "Пропал без вести зимой 1943 года.",
  },
  {
    n: 4,
    gender: "FEMALE",
    names: [name("Морозова", "Ольга", "Ивановна")],
    birth: day("1899-12-05"),
    death: day("1978-08-21"),
    notes: null,
  },
  {
    n: 5,
    gender: "MALE",
    names: [name("Волков", "Илья", "Петрович")],
    birth: day("1926-01-18"),
    death: day("2003-04-09"),
    notes: "Инженер-путеец. Любил фотографировать семейные праздники.",
  },
  {
    n: 6,
    gender: "FEMALE",
    names: [name("Лебедева", "Татьяна", "Николаевна")],
    birth: day("1929-07-02"),
    death: day("2011-10-14"),
    notes: null,
  },
  {
    n: 7,
    gender: "MALE",
    names: [name("Волков", "Виктор", "Петрович")],
    birth: day("1931-05-11"),
    death: day("2015-03-03"),
    notes: null,
  },
  {
    n: 8,
    gender: "FEMALE",
    names: [name("Орлова", "Нина", "Дмитриевна")],
    birth: day("1934-09-19"),
    death: day("2020-01-25"),
    notes: null,
  },
  {
    n: 9,
    gender: "MALE",
    names: [name("Волков", "Андрей", "Ильич")],
    birth: day("1953-02-27"),
    death: UNKNOWN,
    notes:
      "Хранитель семейного архива. Начал собирать фотографии и рассказы родных в 1990-х.",
  },
  {
    n: 10,
    gender: "FEMALE",
    names: [name("Смирнова", "Елена", "Викторовна")],
    birth: day("1956-11-08"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 11,
    gender: "FEMALE",
    names: [name("Волкова", "Марина", "Ильинична")],
    birth: day("1958-04-03"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 12,
    gender: "MALE",
    names: [name("Кузнецов", "Олег", "Борисович")],
    birth: day("1955-08-16"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 13,
    gender: "MALE",
    names: [name("Волков", "Дмитрий", "Викторович")],
    birth: day("1960-01-05"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 14,
    gender: "MALE",
    names: [name("Волков", "Михаил", "Андреевич")],
    birth: day("1981-06-14"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 15,
    gender: "FEMALE",
    names: [name("Иванова", "Ксения", "Александровна")],
    birth: day("1983-03-22"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 16,
    gender: "FEMALE",
    names: [name("Волкова", "Анна", "Андреевна")],
    birth: day("1986-09-30"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 17,
    gender: "MALE",
    names: [name("Кузнецов", "Артём", "Олегович")],
    birth: day("1984-12-11"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 18,
    gender: "FEMALE",
    names: [name("Кузнецова", "Софья", "Олеговна")],
    birth: day("1989-05-07"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 19,
    gender: "MALE",
    names: [name("Волков", "Лев", "Михайлович")],
    birth: day("2012-10-21"),
    death: UNKNOWN,
    notes: null,
  },
  {
    n: 20,
    gender: "FEMALE",
    names: [name("Волкова", "Вера", "Михайловна")],
    birth: day("2015-07-04"),
    death: UNKNOWN,
    notes: null,
  },
].map((person) => ({
  id: personId(person.n),
  gender: person.gender,
  names: person.names,
  birth: person.birth,
  death: person.death,
  notes: person.notes,
  externalIds: [],
}));

const spousePairs = [
  [1, 2],
  [3, 4],
  [5, 6],
  [7, 8],
  [9, 10],
  [11, 12],
  [14, 15],
];

const parentPairs = [
  [1, 5],
  [2, 5],
  [1, 7],
  [2, 7],
  [3, 6],
  [4, 6],
  [5, 9],
  [6, 9],
  [5, 11],
  [6, 11],
  [7, 13],
  [8, 13],
  [9, 14],
  [10, 14],
  [9, 16],
  [10, 16],
  [11, 17],
  [12, 17],
  [11, 18],
  [12, 18],
  [14, 19],
  [15, 19],
  [14, 20],
  [15, 20],
];

let relationshipCounter = 1;
const relationships = [];
for (const [a, b] of spousePairs) {
  const [left, right] = [personId(a), personId(b)].sort();
  relationships.push({
    id: relationshipId(relationshipCounter++),
    type: "SPOUSE",
    personId: left,
    relatedPersonId: right,
    notes: null,
  });
}
for (const [parent, child] of parentPairs) {
  relationships.push({
    id: relationshipId(relationshipCounter++),
    type: "PARENT_CHILD",
    personId: personId(parent),
    relatedPersonId: personId(child),
    notes: null,
  });
}

const sources = [
  {
    id: sourceId(1),
    title: "Семейный архив Волковых",
    author: "Семья Волковых",
    publication: null,
    repository: "Личный архив",
    url: null,
    notes: "Фотографии, письма и записи семейных рассказов.",
  },
  {
    id: sourceId(2),
    title: "Метрические книги Казанской губернии",
    author: null,
    publication: "1900–1910",
    repository: "Государственный архив Республики Татарстан",
    url: null,
    notes: "Синтетический пример источника для демонстрации.",
  },
];

let eventCounter = 1;
const events = [];

function event({
  person,
  type,
  date,
  place = null,
  description = null,
  participants = [],
  details = {},
  sourceIds = [],
}) {
  events.push({
    id: eventId(eventCounter++),
    personId: personId(person),
    type,
    date,
    place,
    placeGeo: placeGeo(place),
    description,
    sourceIds,
    originalType: null,
    participantIds: participants.map(personId),
    details,
  });
}

for (const person of people) {
  const n = Number(person.id.slice(-12));
  event({
    person: n,
    type: "BIRTH",
    date: person.birth,
    place: n <= 8 ? "Казань" : "Москва",
    sourceIds: n <= 4 ? [sourceId(2)] : [sourceId(1)],
  });
  if (person.death.precision !== "UNKNOWN") {
    event({
      person: n,
      type: "DEATH",
      date: person.death,
      place: n <= 7 ? "Казань" : "Москва",
      details:
        n === 3
          ? { cause: "Пропал без вести" }
          : n === 1
            ? { cause: "Сердечная недостаточность" }
            : {},
    });
  }
}

event({
  person: 1,
  type: "MARRIAGE",
  date: day("1924-02-10"),
  place: "Казань",
  participants: [2],
  details: { marriage_rite: "Венчание" },
  sourceIds: [sourceId(2)],
});
event({
  person: 3,
  type: "MARRIAGE",
  date: day("1922-08-17"),
  place: "Казань",
  participants: [4],
});
event({
  person: 5,
  type: "MARRIAGE",
  date: day("1951-05-26"),
  place: "Казань",
  participants: [6],
  details: { marriage_certificate: "Свидетельство № 431" },
});
event({
  person: 7,
  type: "MARRIAGE",
  date: day("1957-09-14"),
  place: "Казань",
  participants: [8],
});
event({
  person: 9,
  type: "MARRIAGE",
  date: day("1979-03-03"),
  place: "Москва",
  participants: [10],
  details: { marriage_certificate: "Свидетельство № 128" },
});
event({
  person: 11,
  type: "MARRIAGE",
  date: day("1981-11-21"),
  place: "Москва",
  participants: [12],
});
event({
  person: 14,
  type: "MARRIAGE",
  date: day("2008-07-12"),
  place: "Москва",
  participants: [15],
});

event({
  person: 1,
  type: "OCCUPATION",
  date: year(1920),
  place: "Казань",
  details: { position: "Столяр", employer: "Артель «Красный древ»" },
});
event({
  person: 5,
  type: "OCCUPATION",
  date: year(1950),
  place: "Казань",
  details: { position: "Инженер-путеец", employer: "Казанское отделение железной дороги" },
});
event({
  person: 9,
  type: "OCCUPATION",
  date: year(1976),
  place: "Москва",
  details: { position: "Преподаватель истории", employer: "Школа № 15" },
});
event({
  person: 14,
  type: "OCCUPATION",
  date: year(2004),
  place: "Москва",
  details: { position: "Программист", employer: "Студия «Север»" },
});
event({
  person: 16,
  type: "OCCUPATION",
  date: year(2009),
  place: "Москва",
  details: { position: "Реставратор", employer: "Государственный музей" },
});

event({
  person: 1,
  type: "RESIDENCE",
  date: year(1912),
  place: "Казань, Большая Проломная улица",
  details: { address: "Казань, Большая Проломная улица, дом 12" },
});
event({
  person: 5,
  type: "RESIDENCE",
  date: year(1960),
  place: "Казань, улица Горького",
  details: { address: "Казань, улица Горького, дом 8, кв. 4" },
});
event({
  person: 9,
  type: "RESIDENCE",
  date: day("1985-09-01"),
  place: "Москва, район Хамовники",
  details: { address: "Москва, улица Льва Толстого, дом 21, кв. 7" },
});
event({
  person: 9,
  type: "RESIDENCE",
  date: unknown("по рассказам родных, 1990-е"),
  description: "Переезд в новый район; точная дата не сохранилась.",
});
event({
  person: 16,
  type: "RESIDENCE",
  date: year(2012),
  place: "Санкт-Петербург",
  details: { address: "Санкт-Петербург, набережная Фонтанки, дом 30" },
});

event({
  person: 9,
  type: "EDUCATION",
  date: year(1970),
  place: "Москва",
  details: {
    institution: "Московский государственный университет",
    faculty: "Исторический факультет",
    specialty: "История",
    qualification: "Историк, преподаватель",
  },
});
event({
  person: 14,
  type: "EDUCATION",
  date: year(1998),
  place: "Москва",
  details: {
    institution: "Московский физико-технический институт",
    faculty: "Факультет управления и прикладной математики",
    specialty: "Прикладная математика и информатика",
  },
});

event({
  person: 3,
  type: "OTHER",
  date: year(1941),
  place: "Брянская область",
  description: "Призван в действующую армию.",
});
event({
  person: 1,
  type: "BURIAL",
  date: day("1974-11-06"),
  place: "Казань, Арское кладбище",
  details: { cemetery: "Арское кладбище", grave: "Участок 4, ряд 12" },
});
event({
  person: 3,
  type: "BURIAL",
  date: unknown("после 1943 года, место неизвестно"),
  description: "Семья не получила известий о месте захоронения.",
});
event({
  person: 8,
  type: "BURIAL",
  date: day("2020-01-28"),
  place: "Москва, Троекуровское кладбище",
  details: { cemetery: "Троекуровское кладбище" },
});

const citations = [];
let citationCounter = 1;
for (const n of [1, 2, 3, 4, 5, 6]) {
  citations.push({
    id: citationId(citationCounter++),
    sourceId: sourceId(n <= 4 ? 2 : 1),
    targetType: "PERSON",
    targetId: personId(n),
    page: n <= 4 ? `${1900 + n}, л. ${n * 3}` : "Письма и фотографии",
    confidence: n <= 4 ? "HIGH" : "MEDIUM",
  });
}
for (const n of [1, 2, 3, 4, 5, 6]) {
  citations.push({
    id: citationId(citationCounter++),
    sourceId: sourceId(1),
    targetType: "EVENT",
    targetId: eventId(n),
    page: null,
    confidence: "MEDIUM",
  });
}

const counts = {
  persons: people.length,
  events: events.length,
  relationships: relationships.length,
  sources: sources.length,
  citations: citations.length,
  media: 0,
};

function contentHash(root) {
  const hasher = crypto.createHash("sha256");
  const schema = Buffer.alloc(4);
  schema.writeUInt32LE(1);
  hasher.update(schema);
  for (const file of [
    "persons.jsonl",
    "relationships.jsonl",
    "events.jsonl",
    "sources.jsonl",
    "citations.jsonl",
    "media.jsonl",
  ]) {
    const full = path.join(root, file);
    const bytes = fs.existsSync(full) ? fs.readFileSync(full) : Buffer.alloc(0);
    const lines = bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
    const lineBytes = Buffer.alloc(8);
    lineBytes.writeBigUInt64LE(BigInt(lines));
    hasher.update(Buffer.from(file, "utf8"));
    hasher.update(lineBytes);
    hasher.update(crypto.createHash("sha256").update(bytes).digest());
  }
  return `sha256:${hasher.digest("hex")}`;
}

const manifest = {
  formatVersion: 5,
  schemaVersion: 1,
  projectId: PROJECT_ID,
  name: "Демо: семья Волковых",
  createdAt: "2026-10-01T09:00:00Z",
  updatedAt: "2026-10-24T18:30:00Z",
  appVersion: "0.2.0",
  homePersonId: HOME_PERSON,
  contentHash: "",
  counts,
};

const projectDir = path.join(OUT, PROJECT_ID);
fs.rmSync(projectDir, { recursive: true, force: true });
fs.mkdirSync(path.join(projectDir, "media"), { recursive: true });

const ROW_TIME = "2026-10-01T09:00:00Z";

function writeJsonl(file, rows) {
  const lines = rows.map((row) =>
    JSON.stringify({
      schema: 1,
      id: row.id,
      createdAt: ROW_TIME,
      updatedAt: ROW_TIME,
      data: row,
    }),
  );
  fs.writeFileSync(
    path.join(projectDir, file),
    lines.join("\n") + (lines.length ? "\n" : ""),
    "utf8",
  );
}

writeJsonl("persons.jsonl", people);
writeJsonl("relationships.jsonl", relationships);
writeJsonl("events.jsonl", events);
writeJsonl("sources.jsonl", sources);
writeJsonl("citations.jsonl", citations);
writeJsonl("media.jsonl", []);
manifest.contentHash = contentHash(projectDir);
fs.writeFileSync(
  path.join(projectDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`demo project: ${projectDir}`);
console.log(
  `persons=${counts.persons} events=${counts.events} relationships=${counts.relationships}`,
);
