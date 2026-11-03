// Generates a synthetic GEDCOM 5.5.1 file from a demo project. The demo
// projects are invented families, so the archive is safe to import, share and
// screenshot.
//
//   node scripts/make-demo-gedcom.mjs [demo-dir] [output-file]
//
// The README demo imports this file through the real app so the recording shows
// a genuine Import run instead of a pre-seeded project folder.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEMO_ROOT = path.resolve(ROOT, process.argv[2] ?? "demo/project-en");
const DEMO = fs.existsSync(path.join(DEMO_ROOT, "persons.jsonl"))
  ? DEMO_ROOT
  : (() => {
      const nested = fs
        .readdirSync(DEMO_ROOT, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            fs.existsSync(path.join(DEMO_ROOT, entry.name, "persons.jsonl")),
        );
      if (nested.length !== 1) {
        console.error(`gedcom: cannot find the project inside ${DEMO_ROOT}`);
        process.exit(1);
      }
      return path.join(DEMO_ROOT, nested[0].name);
    })();
const OUT = path.resolve(
  process.argv[3] ?? path.join(DEMO, "volkov-family.ged"),
);

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

const read = (file) =>
  fs
    .readFileSync(path.join(DEMO, file), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line).data);

const persons = read("persons.jsonl");
const relationships = read("relationships.jsonl");
const events = read("events.jsonl");
const sources = read("sources.jsonl");

/** GEDCOM text escaping: `@` doubles and long lines continue with CONT. */
function text(value) {
  return String(value).replace(/@/g, "@@").replace(/[\r\n]+/g, " ");
}

function pushText(lines, level, tag, value) {
  if (value === null || value === undefined) return;
  const trimmed = String(value).trim();
  if (trimmed === "") return;
  lines.push(`${level} ${tag} ${text(trimmed)}`);
}

function pushNote(lines, level, value) {
  if (value === null || value === undefined) return;
  const parts = String(value).split(/\r?\n/);
  const [first, ...rest] = parts;
  if (first.trim() === "" && rest.length === 0) return;
  lines.push(`${level} NOTE ${text(first)}`);
  for (const line of rest) lines.push(`${level + 1} CONT ${text(line)}`);
}

function formatDatePart(iso, precision) {
  const [year, month, day] = iso.split("-").map(Number);
  if (precision === "DAY") return `${day} ${MONTHS[month - 1]} ${year}`;
  if (precision === "MONTH") return `${MONTHS[month - 1]} ${year}`;
  return String(year);
}

function gedcomDate(date) {
  if (!date || !date.start || date.precision === "UNKNOWN") return null;
  const part = formatDatePart(date.start, date.precision);
  switch (date.qualifier) {
    case "APPROXIMATE":
      return `ABT ${part}`;
    case "BEFORE":
      return `BEF ${part}`;
    case "AFTER":
      return `AFT ${part}`;
    default:
      return part;
  }
}

const personById = new Map(persons.map((person) => [person.id, person]));

// Stable xrefs keep the generated file byte-identical between runs.
const indiXref = new Map(
  [...persons]
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map((person, index) => [person.id, `@I${index + 1}@`]),
);

// --- families -------------------------------------------------------------
// A family is the sorted set of parents; couples get one even without children.
const families = new Map();
function familyFor(parentIds) {
  const key = [...parentIds].sort().join("|");
  let family = families.get(key);
  if (!family) {
    const male = parentIds.find(
      (id) => personById.get(id)?.gender === "MALE",
    );
    const female = parentIds.find(
      (id) => personById.get(id)?.gender === "FEMALE",
    );
    family = {
      key,
      parents: [...parentIds],
      husband: male ?? (female ? undefined : parentIds[0]),
      wife: female ?? (male ? undefined : parentIds[1]),
      children: [],
      xref: `@F${families.size + 1}@`,
    };
    families.set(key, family);
  }
  return family;
}

for (const relation of relationships) {
  if (relation.type === "SPOUSE" || relation.type === "PARTNER") {
    familyFor([relation.personId, relation.relatedPersonId]);
  }
}

const parentsOf = new Map();
for (const relation of relationships) {
  if (
    relation.type === "PARENT_CHILD" ||
    relation.type === "ADOPTIVE_PARENT_CHILD"
  ) {
    const parents = parentsOf.get(relation.relatedPersonId) ?? [];
    parents.push(relation.personId);
    parentsOf.set(relation.relatedPersonId, parents);
  }
}

for (const [childId, parents] of parentsOf) {
  const family = familyFor(parents);
  if (!family.children.includes(childId)) family.children.push(childId);
}

// --- individuals ----------------------------------------------------------
const eventsByPerson = new Map();
for (const event of events) {
  const list = eventsByPerson.get(event.personId) ?? [];
  list.push(event);
  eventsByPerson.set(event.personId, list);
}

const EVENT_TAGS = {
  BIRTH: "BIRT",
  DEATH: "DEAT",
  MARRIAGE: "MARR",
  DIVORCE: "DIV",
  BURIAL: "BURI",
  RESIDENCE: "RESI",
  OCCUPATION: "OCCU",
  EDUCATION: "EDUC",
};

const lines = [];
lines.push("0 HEAD");
lines.push("1 SOUR GENTREE");
lines.push("2 NAME Gentree");
lines.push("2 VERS 0.4.0");
pushText(lines, 1, "FILE", path.basename(OUT));
lines.push("1 GEDC");
lines.push("2 VERS 5.5.1");
lines.push("2 FORM LINEAGE-LINKED");
lines.push("1 CHAR UTF-8");
lines.push("1 DATE 1 NOV 2026");
lines.push("1 SUBM @U1@");
lines.push("0 @U1@ SUBM");
pushText(lines, 1, "NAME", "Gentree demo");

for (const person of [...persons].sort((left, right) => (left.id < right.id ? -1 : 1))) {
  lines.push(`0 ${indiXref.get(person.id)} INDI`);
  const primary = person.names.find((name) => name.isPrimary) ?? person.names[0];
  if (primary) {
    const given = [primary.given, primary.patronymic].filter(Boolean).join(" ");
    const surname = primary.surname ? `/${primary.surname}/` : "";
    lines.push(`1 NAME ${text([given, surname].filter(Boolean).join(" "))}`);
    pushText(lines, 2, "GIVN", primary.given);
    if (primary.patronymic) {
      // Gentree reads the patronymic from the vendor tag it also writes.
      pushText(lines, 2, "_PATR", primary.patronymic);
    }
    pushText(lines, 2, "SURN", primary.surname);
    pushText(lines, 2, "SPFX", primary.prefix);
    pushText(lines, 2, "NSFX", primary.suffix);
    if (primary.nameType && primary.nameType !== "BIRTH") {
      pushText(lines, 2, "TYPE", primary.nameType.toLowerCase());
    }
  }
  lines.push(`1 SEX ${person.gender === "MALE" ? "M" : person.gender === "FEMALE" ? "F" : "U"}`);

  for (const event of eventsByPerson.get(person.id) ?? []) {
    const tag = EVENT_TAGS[event.type] ?? "EVEN";
    lines.push(`1 ${tag}`);
    if (tag === "EVEN") pushText(lines, 2, "TYPE", event.originalType ?? "Event");
    const date = gedcomDate(event.date);
    if (date) lines.push(`2 DATE ${date}`);
    pushText(lines, 2, "PLAC", event.place);
    pushText(lines, 2, "NOTE", event.description);
    if (event.type === "MARRIAGE" && event.details?.marriage_rite) {
      pushText(lines, 2, "TYPE", event.details.marriage_rite);
    }
  }

  pushNote(lines, 1, person.notes);

  for (const [childId, parents] of parentsOf) {
    if (childId !== person.id) continue;
    const family = families.get([...parents].sort().join("|"));
    if (family) lines.push(`1 FAMC ${family.xref}`);
  }
  const ownFamilies = [...families.values()].filter((family) =>
    family.parents.includes(person.id),
  );
  for (const family of ownFamilies) lines.push(`1 FAMS ${family.xref}`);
}

for (const family of families.values()) {
  lines.push(`0 ${family.xref} FAM`);
  if (family.husband) lines.push(`1 HUSB ${indiXref.get(family.husband)}`);
  if (family.wife) lines.push(`1 WIFE ${indiXref.get(family.wife)}`);
  for (const child of [...family.children].sort()) {
    lines.push(`1 CHIL ${indiXref.get(child)}`);
  }
}

for (const [index, source] of sources.entries()) {
  lines.push(`0 @S${index + 1}@ SOUR`);
  pushText(lines, 1, "TITL", source.title);
  pushText(lines, 1, "AUTH", source.author);
  pushText(lines, 1, "PUBL", source.publication);
  pushNote(lines, 1, source.notes);
}

lines.push("0 TRLR");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${lines.join("\n")}\n`, "utf8");

console.log(
  `gedcom: ${OUT} (${persons.length} people, ${families.size} families, ${events.length} events)`,
);
