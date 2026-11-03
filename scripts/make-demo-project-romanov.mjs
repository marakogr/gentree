// Generates the Romanov demo project: a deterministic, historically grounded
// tree of the last imperial family. Dates follow the New Style (Gregorian)
// calendar; uncertain ones carry a qualifier instead of a made-up day.
//
//   node scripts/make-demo-project-romanov.mjs demo/romanov ru
//   node scripts/make-demo-project-romanov.mjs demo/romanov-en en
//
// The project is a normal Gentree folder (manifest + JSONL collections with the
// standard row envelope), so the app reads it exactly like any other project.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_ROOT = path.resolve(ROOT, process.argv[2] ?? "demo/romanov");
const LANG = process.argv[3] === "en" ? "en" : "ru";
const PROJECT_ID =
  LANG === "en"
    ? "d3e00000-0000-4000-8000-000000000012"
    : "d3e00000-0000-4000-8000-000000000011";
const ROW_TIME = "2026-10-01T09:00:00Z";
const OUT = path.join(OUT_ROOT, PROJECT_ID);

const pick = (value) => (typeof value === "string" ? value : value[LANG]);

// --- identifiers ----------------------------------------------------------
const personId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const eventId = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const relationshipId = (index) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const sourceId = (index) => `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const citationId = (index) => `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

// --- dates ----------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;

function nextDay(iso) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

function nextMonth(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function nextYear(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

/** A DateValue with an exclusive end that matches its precision. */
function date(iso, precision = "DAY", qualifier = "EXACT") {
  const end =
    precision === "DAY" ? nextDay(iso) : precision === "MONTH" ? nextMonth(iso) : nextYear(iso);
  return { start: iso, end, precision, qualifier, original: null };
}

const unknownDate = () => ({
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
});

// --- places ---------------------------------------------------------------
const PLACES = {
  spb: {
    place: { ru: "Санкт-Петербург", en: "Saint Petersburg" },
    lat: 59.9386,
    lon: 30.3141,
    precision: "SETTLEMENT",
  },
  tsarskoe: {
    place: { ru: "Царское Село", en: "Tsarskoye Selo" },
    lat: 59.7196,
    lon: 30.4148,
    precision: "SETTLEMENT",
  },
  peterhof: {
    place: { ru: "Петергоф", en: "Peterhof" },
    lat: 59.885,
    lon: 29.9086,
    precision: "SETTLEMENT",
  },
  gatchina: {
    place: { ru: "Гатчина", en: "Gatchina" },
    lat: 59.5654,
    lon: 30.1281,
    precision: "SETTLEMENT",
  },
  moscow: {
    place: { ru: "Москва", en: "Moscow" },
    lat: 55.7558,
    lon: 37.6173,
    precision: "SETTLEMENT",
  },
  livadia: {
    place: { ru: "Ливадия", en: "Livadia" },
    lat: 44.4708,
    lon: 34.1439,
    precision: "POINT",
  },
  tobolsk: {
    place: { ru: "Тобольск", en: "Tobolsk" },
    lat: 58.2017,
    lon: 68.2537,
    precision: "SETTLEMENT",
  },
  ekb: {
    place: { ru: "Екатеринбург", en: "Yekaterinburg" },
    lat: 56.8389,
    lon: 60.6057,
    precision: "SETTLEMENT",
  },
  perm: {
    place: { ru: "Пермь", en: "Perm" },
    lat: 58.0105,
    lon: 56.2502,
    precision: "SETTLEMENT",
  },
  abastumani: {
    place: { ru: "Абастумани", en: "Abastumani" },
    lat: 41.7544,
    lon: 42.8314,
    precision: "SETTLEMENT",
  },
  darmstadt: {
    place: { ru: "Дармштадт", en: "Darmstadt" },
    lat: 49.8728,
    lon: 8.6512,
    precision: "SETTLEMENT",
  },
  copenhagen: {
    place: { ru: "Копенгаген", en: "Copenhagen" },
    lat: 55.6761,
    lon: 12.5683,
    precision: "SETTLEMENT",
  },
  london: {
    place: { ru: "Лондон", en: "London" },
    lat: 51.5074,
    lon: -0.1278,
    precision: "SETTLEMENT",
  },
  toronto: {
    place: { ru: "Торонто", en: "Toronto" },
    lat: 43.6532,
    lon: -79.3832,
    precision: "SETTLEMENT",
  },
  berlin: {
    place: { ru: "Берлин", en: "Berlin" },
    lat: 52.52,
    lon: 13.405,
    precision: "SETTLEMENT",
  },
};

function geo(place) {
  const entry = PLACES[place];
  return {
    lat: entry.lat,
    lon: entry.lon,
    precision: entry.precision,
    source: "MANUAL",
    providerRef: null,
    label: pick(entry.place),
  };
}

// --- people ---------------------------------------------------------------
// `given`, `patronymic` and `surname` are per language; regnal numbers stay in
// the given name, the way the family is usually listed in Russian.
const PEOPLE = [
  {
    id: 1,
    gender: "MALE",
    name: {
      ru: ["Александр II", "Николаевич", "Романов"],
      en: ["Alexander II", "Nikolaevich", "Romanov"],
    },
    birth: date("1818-04-29"),
    birthPlace: "moscow",
    death: date("1881-03-13"),
    deathPlace: "spb",
    notes: {
      ru: "Император Всероссийский с 1855 года. Отменил крепостное право в 1861 году, погиб от бомбы народовольцев на Екатерининском канале.",
      en: "Emperor of All Russia from 1855. Emancipated the serfs in 1861 and was killed by a bomb on the Catherine Canal.",
    },
  },
  {
    id: 2,
    gender: "FEMALE",
    name: {
      ru: ["Мария", "Александровна", "Романова"],
      en: ["Maria", "Alexandrovna", "Romanova"],
    },
    birth: date("1824-08-08"),
    birthPlace: "darmstadt",
    death: date("1880-06-03"),
    deathPlace: "spb",
    notes: {
      ru: "Урождённая принцесса Гессен-Дармштадтская. Покровительствовала женскому образованию, основала Мариинские гимназии.",
      en: "Born a princess of Hesse-Darmstadt. Patron of women's education and founder of the Mariinsky gymnasiums.",
    },
  },
  {
    id: 3,
    gender: "MALE",
    name: {
      ru: ["Александр III", "Александрович", "Романов"],
      en: ["Alexander III", "Alexandrovich", "Romanov"],
    },
    birth: date("1845-03-10"),
    birthPlace: "spb",
    death: date("1894-11-01"),
    deathPlace: "livadia",
    notes: {
      ru: "Император с 1881 года. Жил с семьёй в Гатчине, вёл осторожную внешнюю политику; умер в Ливадии от болезни почек.",
      en: "Emperor from 1881. Lived with his family in Gatchina and kept a cautious foreign policy; died in Livadia of kidney disease.",
    },
  },
  {
    id: 4,
    gender: "FEMALE",
    name: {
      ru: ["Мария", "Фёдоровна", "Романова"],
      en: ["Maria", "Feodorovna", "Romanova"],
    },
    birth: date("1847-11-26"),
    birthPlace: "copenhagen",
    death: date("1928-10-13"),
    deathPlace: "copenhagen",
    notes: {
      ru: "Урождённая принцесса Дагмар Датская. После революции жила в Дании, умерла на вилле Хвидоре под Копенгагеном.",
      en: "Born Princess Dagmar of Denmark. After the revolution she lived in Denmark and died at Hvidøre near Copenhagen.",
    },
  },
  {
    id: 5,
    gender: "MALE",
    name: {
      ru: ["Николай II", "Александрович", "Романов"],
      en: ["Nicholas II", "Alexandrovich", "Romanov"],
    },
    birth: date("1868-05-18"),
    birthPlace: "tsarskoe",
    death: date("1918-07-17"),
    deathPlace: "ekb",
    notes: {
      ru: "Последний император Всероссийский, с 1894 года. Отрёкся от престола 2 (15) марта 1917 года; расстрелян с семьёй в Екатеринбурге.",
      en: "The last Emperor of All Russia, from 1894. Abdicated on 15 March 1917 and was shot with his family in Yekaterinburg.",
    },
  },
  {
    id: 6,
    gender: "FEMALE",
    name: {
      ru: ["Александра", "Фёдоровна", "Романова"],
      en: ["Alexandra", "Feodorovna", "Romanova"],
    },
    birth: date("1872-06-06"),
    birthPlace: "darmstadt",
    death: date("1918-07-17"),
    deathPlace: "ekb",
    notes: {
      ru: "Урождённая принцесса Алиса Гессен-Дармштадтская, внучка королевы Виктории. Шеф лейб-гвардии, сестра милосердия в годы войны.",
      en: "Born Princess Alix of Hesse-Darmstadt, a granddaughter of Queen Victoria. Colonel-in-chief of the guards and a wartime nurse.",
    },
  },
  {
    id: 7,
    gender: "FEMALE",
    name: {
      ru: ["Ольга", "Николаевна", "Романова"],
      en: ["Olga", "Nikolaevna", "Romanova"],
    },
    birth: date("1895-11-15"),
    birthPlace: "tsarskoe",
    death: date("1918-07-17"),
    deathPlace: "ekb",
    notes: {
      ru: "Великая княжна, старшая дочь Николая II. В войну работала сестрой милосердия в лазарете Царского Села.",
      en: "Grand Duchess, the eldest daughter of Nicholas II. Worked as a wartime nurse in a Tsarskoye Selo hospital.",
    },
  },
  {
    id: 8,
    gender: "FEMALE",
    name: {
      ru: ["Татьяна", "Николаевна", "Романова"],
      en: ["Tatiana", "Nikolaevna", "Romanova"],
    },
    birth: date("1897-06-10"),
    birthPlace: "peterhof",
    death: date("1918-07-17"),
    deathPlace: "ekb",
    notes: {
      ru: "Великая княжна. Вместе с сестрой Ольгой заведовала военным лазаретом; считалась самой близкой к матери из дочерей.",
      en: "Grand Duchess. With her sister Olga she ran a military hospital; she was the daughter closest to her mother.",
    },
  },
  {
    id: 9,
    gender: "FEMALE",
    name: {
      ru: ["Мария", "Николаевна", "Романова"],
      en: ["Maria", "Nikolaevna", "Romanova"],
    },
    birth: date("1899-06-26"),
    birthPlace: "peterhof",
    death: date("1918-07-17"),
    deathPlace: "ekb",
    notes: {
      ru: "Великая княжна, известная мягким характером и силой. В ссылке в Тобольске ухаживала за больными.",
      en: "Grand Duchess, known for her gentle temper and strength. In Tobolsk she nursed the sick.",
    },
  },
  {
    id: 10,
    gender: "FEMALE",
    name: {
      ru: ["Анастасия", "Николаевна", "Романова"],
      en: ["Anastasia", "Nikolaevna", "Romanova"],
    },
    birth: date("1901-06-18"),
    birthPlace: "peterhof",
    death: date("1918-07-17"),
    deathPlace: "ekb",
    notes: {
      ru: "Великая княжна, младшая дочь. Её судьба породила множество самозванцев после 1918 года.",
      en: "Grand Duchess, the youngest daughter. Her fate produced many impostors after 1918.",
    },
  },
  {
    id: 11,
    gender: "MALE",
    name: {
      ru: ["Алексей", "Николаевич", "Романов"],
      en: ["Alexei", "Nikolaevich", "Romanov"],
    },
    birth: date("1904-08-12"),
    birthPlace: "peterhof",
    death: date("1918-07-17"),
    deathPlace: "ekb",
    notes: {
      ru: "Цесаревич, наследник престола. С рождения болел гемофилией, что сильно повлияло на жизнь семьи.",
      en: "Tsesarevich and heir to the throne. He suffered from haemophilia from birth, which shaped the family's life.",
    },
  },
  {
    id: 12,
    gender: "MALE",
    name: {
      ru: ["Георгий", "Александрович", "Романов"],
      en: ["George", "Alexandrovich", "Romanov"],
    },
    birth: date("1871-05-09"),
    birthPlace: "tsarskoe",
    death: date("1899-08-10"),
    deathPlace: "abastumani",
    notes: {
      ru: "Великий князь, второй сын Александра III. Умер от туберкулёза в Абастумани, где жил по совету врачей.",
      en: "Grand Duke, the second son of Alexander III. Died of tuberculosis in Abastumani, where he lived on doctors' advice.",
    },
  },
  {
    id: 13,
    gender: "FEMALE",
    name: {
      ru: ["Ксения", "Александровна", "Романова"],
      en: ["Xenia", "Alexandrovna", "Romanova"],
    },
    birth: date("1875-04-06"),
    birthPlace: "spb",
    death: date("1960-04-20"),
    deathPlace: "london",
    notes: {
      ru: "Великая княгиня, сестра Николая II. После революции жила в эмиграции в Дании и Великобритании.",
      en: "Grand Duchess, sister of Nicholas II. After the revolution she lived in exile in Denmark and Britain.",
    },
  },
  {
    id: 14,
    gender: "MALE",
    name: {
      ru: ["Михаил", "Александрович", "Романов"],
      en: ["Michael", "Alexandrovich", "Romanov"],
    },
    birth: date("1878-12-04"),
    birthPlace: "spb",
    death: date("1918-06-13"),
    deathPlace: "perm",
    notes: {
      ru: "Великий князь, младший брат Николая II. В марте 1917 года на день принял титул императора; убит в Перми.",
      en: "Grand Duke, the younger brother of Nicholas II. Briefly accepted the imperial title in March 1917; killed in Perm.",
    },
  },
  {
    id: 15,
    gender: "FEMALE",
    name: {
      ru: ["Ольга", "Александровна", "Романова"],
      en: ["Olga", "Alexandrovna", "Romanova"],
    },
    birth: date("1882-06-13"),
    birthPlace: "peterhof",
    death: date("1960-11-24"),
    deathPlace: "toronto",
    notes: {
      ru: "Великая княгиня, младшая сестра Николая II. Эмигрировала, умерла в Торонто; художница и благотворительница.",
      en: "Grand Duchess, the youngest sister of Nicholas II. Emigrated and died in Toronto; a painter and philanthropist.",
    },
  },
  {
    id: 16,
    gender: "MALE",
    name: {
      ru: ["Николай I", "Павлович", "Романов"],
      en: ["Nicholas I", "Pavlovich", "Romanov"],
    },
    birth: date("1796-07-06"),
    birthPlace: "tsarskoe",
    death: date("1855-03-02"),
    deathPlace: "spb",
    notes: {
      ru: "Император с 1825 года. При нём построена первая железная дорога Петербург — Царское Село; умер в разгар Крымской войны.",
      en: "Emperor from 1825. The first railway from Petersburg to Tsarskoye Selo was built under him; died during the Crimean War.",
    },
  },
  {
    id: 17,
    gender: "FEMALE",
    name: {
      ru: ["Александра", "Фёдоровна", "Романова"],
      en: ["Alexandra", "Feodorovna", "Romanova"],
    },
    birth: date("1798-07-13"),
    birthPlace: "berlin",
    death: date("1860-11-01"),
    deathPlace: "tsarskoe",
    notes: {
      ru: "Урождённая принцесса Шарлотта Прусская. Мать Александра II, попечительница женских учебных заведений.",
      en: "Born Princess Charlotte of Prussia. Mother of Alexander II and patron of women's schools.",
    },
  },
];

// --- events ---------------------------------------------------------------
// `participants` names the other people in the event (marriages).
const EVENTS = [
  // Alexander II
  { person: 1, type: "BIRTH", date: date("1818-04-29"), place: "moscow", sources: [1] },
  { person: 1, type: "MARRIAGE", date: date("1841-04-28"), place: "spb", participants: [2], sources: [2], details: { marriage_rite: { ru: "Православное венчание", en: "Orthodox wedding" }, officiant: { ru: "Протопресвитер", en: "Protopresbyter" } } },
  { person: 1, type: "OCCUPATION", date: date("1855-03-02"), place: "spb", details: { position: { ru: "Император Всероссийский", en: "Emperor of All Russia" }, employer: { ru: "Российская империя", en: "Russian Empire" } } },
  { person: 1, type: "DEATH", date: date("1881-03-13"), place: "spb", sources: [3], details: { cause: { ru: "Смертельное ранение", en: "Fatal wound" } } },
  // Maria Alexandrovna
  { person: 2, type: "BIRTH", date: date("1824-08-08"), place: "darmstadt", sources: [1] },
  { person: 2, type: "MARRIAGE", date: date("1841-04-28"), place: "spb", participants: [1], sources: [2] },
  { person: 2, type: "DEATH", date: date("1880-06-03"), place: "spb", sources: [3] },
  // Alexander III
  { person: 3, type: "BIRTH", date: date("1845-03-10"), place: "spb", sources: [1] },
  { person: 3, type: "MARRIAGE", date: date("1866-10-28"), place: "spb", participants: [4], sources: [2], details: { marriage_rite: { ru: "Православное венчание", en: "Orthodox wedding" } } },
  { person: 3, type: "OCCUPATION", date: date("1881-03-13"), place: "spb", details: { position: { ru: "Император Всероссийский", en: "Emperor of All Russia" }, employer: { ru: "Российская империя", en: "Russian Empire" } } },
  { person: 3, type: "RESIDENCE", date: date("1881-04-01", "YEAR", "APPROXIMATE"), place: "gatchina", details: { address: { ru: "Большой Гатчинский дворец", en: "Gatchina Palace" } } },
  { person: 3, type: "DEATH", date: date("1894-11-01"), place: "livadia", sources: [3], details: { cause: { ru: "Болезнь почек", en: "Kidney disease" } } },
  // Maria Feodorovna
  { person: 4, type: "BIRTH", date: date("1847-11-26"), place: "copenhagen", sources: [1] },
  { person: 4, type: "MARRIAGE", date: date("1866-10-28"), place: "spb", participants: [3], sources: [2] },
  { person: 4, type: "DEATH", date: date("1928-10-13"), place: "copenhagen", sources: [3] },
  // Nicholas II
  { person: 5, type: "BIRTH", date: date("1868-05-18"), place: "tsarskoe", sources: [1] },
  { person: 5, type: "EDUCATION", date: date("1885-01-01", "YEAR", "APPROXIMATE"), place: "tsarskoe", details: { institution: { ru: "Домашнее обучение", en: "Home tutoring" }, specialty: { ru: "Военные и юридические науки", en: "Military and legal studies" } } },
  { person: 5, type: "OCCUPATION", date: date("1894-11-01"), place: "spb", details: { position: { ru: "Император Всероссийский", en: "Emperor of All Russia" }, employer: { ru: "Российская империя", en: "Russian Empire" } } },
  { person: 5, type: "MARRIAGE", date: date("1894-11-26"), place: "spb", participants: [6], sources: [2], details: { marriage_rite: { ru: "Православное венчание", en: "Orthodox wedding" } } },
  { person: 5, type: "OTHER", date: date("1896-05-26"), place: "moscow", description: { ru: "Коронация в Успенском соборе Московского Кремля.", en: "Coronation in the Dormition Cathedral of the Moscow Kremlin." }, sources: [2] },
  { person: 5, type: "RESIDENCE", date: date("1917-08-14"), place: "tobolsk", details: { address: { ru: "Губернаторский дом", en: "Governor's house" } } },
  { person: 5, type: "RESIDENCE", date: date("1918-04-30"), place: "ekb", details: { address: { ru: "Дом Ипатьева", en: "Ipatiev House" } } },
  { person: 5, type: "DEATH", date: date("1918-07-17"), place: "ekb", sources: [3], details: { cause: { ru: "Расстрел", en: "Execution" } } },
  // Alexandra Feodorovna
  { person: 6, type: "BIRTH", date: date("1872-06-06"), place: "darmstadt", sources: [1] },
  { person: 6, type: "MARRIAGE", date: date("1894-11-26"), place: "spb", participants: [5], sources: [2] },
  { person: 6, type: "DEATH", date: date("1918-07-17"), place: "ekb", sources: [3] },
  // Children
  { person: 7, type: "BIRTH", date: date("1895-11-15"), place: "tsarskoe", sources: [1] },
  { person: 7, type: "DEATH", date: date("1918-07-17"), place: "ekb" },
  { person: 8, type: "BIRTH", date: date("1897-06-10"), place: "peterhof", sources: [1] },
  { person: 8, type: "DEATH", date: date("1918-07-17"), place: "ekb" },
  { person: 9, type: "BIRTH", date: date("1899-06-26"), place: "peterhof", sources: [1] },
  { person: 9, type: "DEATH", date: date("1918-07-17"), place: "ekb" },
  { person: 10, type: "BIRTH", date: date("1901-06-18"), place: "peterhof", sources: [1] },
  { person: 10, type: "DEATH", date: date("1918-07-17"), place: "ekb" },
  { person: 11, type: "BIRTH", date: date("1904-08-12"), place: "peterhof", sources: [1] },
  { person: 11, type: "DEATH", date: date("1918-07-17"), place: "ekb" },
  // Siblings
  { person: 12, type: "BIRTH", date: date("1871-05-09"), place: "tsarskoe", sources: [1] },
  { person: 12, type: "DEATH", date: date("1899-08-10"), place: "abastumani", details: { cause: { ru: "Туберкулёз", en: "Tuberculosis" } } },
  { person: 13, type: "BIRTH", date: date("1875-04-06"), place: "spb", sources: [1] },
  { person: 13, type: "RESIDENCE", date: date("1919-01-01", "YEAR", "APPROXIMATE"), place: "london", details: { address: { ru: "Великобритания, эмиграция", en: "Britain, in exile" } } },
  { person: 13, type: "DEATH", date: date("1960-04-20"), place: "london" },
  { person: 14, type: "BIRTH", date: date("1878-12-04"), place: "spb", sources: [1] },
  { person: 14, type: "DEATH", date: date("1918-06-13"), place: "perm" },
  { person: 15, type: "BIRTH", date: date("1882-06-13"), place: "peterhof", sources: [1] },
  { person: 15, type: "DEATH", date: date("1960-11-24"), place: "toronto" },
  // Nicholas I and Alexandra Feodorovna
  { person: 16, type: "BIRTH", date: date("1796-07-06"), place: "tsarskoe", sources: [1] },
  { person: 16, type: "MARRIAGE", date: date("1817-07-13"), place: "spb", participants: [17], details: { marriage_rite: { ru: "Православное венчание", en: "Orthodox wedding" } } },
  { person: 16, type: "DEATH", date: date("1855-03-02"), place: "spb", sources: [3] },
  { person: 17, type: "BIRTH", date: date("1798-07-13"), place: "berlin", sources: [1] },
  { person: 17, type: "MARRIAGE", date: date("1817-07-13"), place: "spb", participants: [16] },
  { person: 17, type: "DEATH", date: date("1860-11-01"), place: "tsarskoe", sources: [3] },
  // One undated family story keeps the "undated" list honest.
  {
    person: 5,
    type: "OTHER",
    date: unknownDate(),
    original: { ru: "по семейному преданию, конец 1917 года", en: "according to a family story, late 1917" },
    description: {
      ru: "Семейное предание: в Тобольске Алексей начал вести дневник, который не сохранился.",
      en: "A family story: in Tobolsk Alexei began a diary that has not survived.",
    },
  },
];

// --- relationships --------------------------------------------------------
const PARENTS = [
  [16, 1],
  [17, 1],
  [1, 3],
  [2, 3],
  [3, 5],
  [4, 5],
  [3, 12],
  [4, 12],
  [3, 13],
  [4, 13],
  [3, 14],
  [4, 14],
  [3, 15],
  [4, 15],
  [5, 7],
  [6, 7],
  [5, 8],
  [6, 8],
  [5, 9],
  [6, 9],
  [5, 10],
  [6, 10],
  [5, 11],
  [6, 11],
];
const SPOUSES = [
  [16, 17],
  [1, 2],
  [3, 4],
  [5, 6],
];

// --- sources --------------------------------------------------------------
const SOURCES = [
  {
    id: 1,
    title: { ru: "Дневники Николая II", en: "The Diaries of Nicholas II" },
    author: { ru: "Николай II", en: "Nicholas II" },
    publication: null,
    repository: { ru: "ГА РФ, ф. 601", en: "State Archive of the Russian Federation, f. 601" },
    url: null,
    notes: {
      ru: "Записи 1894–1918 годов. Даты в проекте приведены по новому стилю.",
      en: "Entries from 1894 to 1918. Dates in this project follow the Gregorian calendar.",
    },
  },
  {
    id: 2,
    title: { ru: "Письма императрицы Александры Фёдоровны", en: "Letters of Empress Alexandra Feodorovna" },
    author: { ru: "Александра Фёдоровна", en: "Alexandra Feodorovna" },
    publication: { ru: "1894–1917", en: "1894-1917" },
    repository: { ru: "ГА РФ, ф. 640", en: "State Archive of the Russian Federation, f. 640" },
    url: null,
    notes: {
      ru: "Переписка с родными; упоминает коронацию, войны и ссылку.",
      en: "Family correspondence; mentions the coronation, the wars and the exile.",
    },
  },
  {
    id: 3,
    title: { ru: "Романовы: биографический справочник", en: "The Romanovs: A Biographical Reference" },
    author: { ru: "Синодальная комиссия", en: "Synodal Commission" },
    publication: { ru: "Москва, 2001", en: "Moscow, 2001" },
    repository: { ru: "РГИА", en: "Russian State Historical Archive" },
    url: null,
    notes: {
      ru: "Сводные даты рождения, брака и смерти; даты по новому стилю.",
      en: "Consolidated birth, marriage and death dates in the Gregorian calendar.",
    },
  },
];

const CITATIONS = [
  { source: 1, targetType: "PERSON", target: 5, page: { ru: "1894, л. 1", en: "1894, f. 1" } },
  { source: 1, targetType: "PERSON", target: 7, page: { ru: "1895, л. 112", en: "1895, f. 112" } },
  { source: 1, targetType: "PERSON", target: 11, page: { ru: "1904, л. 45", en: "1904, f. 45" } },
  { source: 2, targetType: "PERSON", target: 6, page: { ru: "письмо 12", en: "letter 12" } },
  { source: 2, targetType: "PERSON", target: 3, page: { ru: "письмо 3", en: "letter 3" } },
  { source: 3, targetType: "PERSON", target: 1, page: { ru: "с. 5", en: "p. 5" } },
  { source: 3, targetType: "PERSON", target: 16, page: { ru: "с. 12", en: "p. 12" } },
  { source: 3, targetType: "PERSON", target: 17, page: { ru: "с. 14", en: "p. 14" } },
  { source: 3, targetType: "PERSON", target: 4, page: { ru: "с. 31", en: "p. 31" } },
  { source: 3, targetType: "PERSON", target: 12, page: { ru: "с. 44", en: "p. 44" } },
  { source: 3, targetType: "PERSON", target: 14, page: { ru: "с. 58", en: "p. 58" } },
  { source: 3, targetType: "PERSON", target: 15, page: { ru: "с. 61", en: "p. 61" } },
];

// --- assembly -------------------------------------------------------------
const persons = PEOPLE.map((person) => ({
  schema: 1,
  id: personId(person.id),
  createdAt: ROW_TIME,
  updatedAt: ROW_TIME,
  data: {
    id: personId(person.id),
    gender: person.gender,
    names: [
      {
        given: pick(person.name)[0],
        patronymic: pick(person.name)[1],
        surname: pick(person.name)[2],
        prefix: null,
        suffix: null,
        nameType: "BIRTH",
        isPrimary: true,
      },
    ],
    birth: person.birth,
    death: person.death,
    notes: pick(person.notes),
    externalIds: [],
  },
}));

const events = EVENTS.map((event, index) => {
  const details = {};
  for (const [key, value] of Object.entries(event.details ?? {})) {
    details[key] = pick(value);
  }
  const entry = {
    schema: 1,
    id: eventId(index + 1),
    createdAt: ROW_TIME,
    updatedAt: ROW_TIME,
    data: {
      id: eventId(index + 1),
      personId: personId(event.person),
      type: event.type,
      date: event.date,
      place: event.place ? pick(PLACES[event.place].place) : null,
      placeGeo: event.place ? geo(event.place) : null,
      description: event.description ? pick(event.description) : null,
      sourceIds: (event.sources ?? []).map((id) => sourceId(id)),
      originalType: null,
      participantIds: (event.participants ?? []).map((id) => personId(id)),
      details,
    },
  };
  if (event.original) entry.data.date.original = pick(event.original);
  return entry;
});

const relationships = [];
let relationshipIndex = 1;
for (const [parent, child] of PARENTS) {
  relationships.push({
    schema: 1,
    id: relationshipId(relationshipIndex),
    createdAt: ROW_TIME,
    updatedAt: ROW_TIME,
    data: {
      id: relationshipId(relationshipIndex),
      type: "PARENT_CHILD",
      personId: personId(parent),
      relatedPersonId: personId(child),
      notes: null,
    },
  });
  relationshipIndex += 1;
}
for (const [left, right] of SPOUSES) {
  relationships.push({
    schema: 1,
    id: relationshipId(relationshipIndex),
    createdAt: ROW_TIME,
    updatedAt: ROW_TIME,
    data: {
      id: relationshipId(relationshipIndex),
      type: "SPOUSE",
      personId: personId(left),
      relatedPersonId: personId(right),
      notes: null,
    },
  });
  relationshipIndex += 1;
}

const sources = SOURCES.map((source) => ({
  schema: 1,
  id: sourceId(source.id),
  createdAt: ROW_TIME,
  updatedAt: ROW_TIME,
  data: {
    id: sourceId(source.id),
    title: pick(source.title),
    author: source.author ? pick(source.author) : null,
    publication: source.publication ? pick(source.publication) : null,
    repository: source.repository ? pick(source.repository) : null,
    url: source.url,
    notes: pick(source.notes),
  },
}));

const citations = CITATIONS.map((citation, index) => ({
  schema: 1,
  id: citationId(index + 1),
  createdAt: ROW_TIME,
  updatedAt: ROW_TIME,
  data: {
    id: citationId(index + 1),
    sourceId: sourceId(citation.source),
    targetType: citation.targetType,
    targetId: personId(citation.target),
    page: pick(citation.page),
    confidence: "HIGH",
  },
}));

// --- files ----------------------------------------------------------------
function writeJsonl(name, rows) {
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  fs.writeFileSync(path.join(OUT, name), rows.length > 0 ? `${text}\n` : "", "utf8");
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "media"), { recursive: true });

const manifest = {
  formatVersion: 5,
  schemaVersion: 1,
  projectId: PROJECT_ID,
  name: LANG === "en" ? "Demo: the Romanov family" : "Демо: семья Романовых",
  createdAt: ROW_TIME,
  updatedAt: ROW_TIME,
  appVersion: "0.4.0",
  homePersonId: personId(5),
  contentHash: "",
  counts: {
    persons: persons.length,
    events: events.length,
    relationships: relationships.length,
    sources: sources.length,
    citations: citations.length,
    media: 0,
  },
};

writeJsonl("persons.jsonl", persons);
writeJsonl("events.jsonl", events);
writeJsonl("relationships.jsonl", relationships);
writeJsonl("sources.jsonl", sources);
writeJsonl("citations.jsonl", citations);
writeJsonl("media.jsonl", []);

/** Same digest the storage layer writes into the manifest. */
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

fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
manifest.contentHash = contentHash(OUT);
fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  `romanov: ${OUT} — ${persons.length} people, ${events.length} events, ` +
    `${relationships.length} relationships, ${sources.length} sources`,
);
