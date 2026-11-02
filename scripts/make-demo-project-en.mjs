// Generates an English edition of the synthetic demo project.
//
//   node scripts/make-demo-project-en.mjs [output-dir]
//
// The Russian generator owns the structure; this script runs it into a
// temporary folder, translates every visible string, assigns a new project id
// and recalculates the manifest hash. No real names, dates or places are used.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = process.argv[2] ?? path.join(ROOT, "demo", "project-en");
const SOURCE_ID = "d3e00000-0000-4000-8000-000000000001";
const PROJECT_ID = "d3e00000-0000-4000-8000-000000000002";

const translations = {
  "Александровна": "Alexandrovna",
  "Андреевич": "Andreevich",
  "Андреевна": "Andreevna",
  "Андрей": "Andrew",
  "Анна": "Anna",
  "Арское кладбище": "Arskoe Cemetery",
  "Артель «Красный древ»": "Krasny Drev artel",
  "Артём": "Artyom",
  "Борисович": "Borisovich",
  "Брянская область": "Bryansk Oblast",
  "Венчание": "Church wedding",
  "Вера": "Vera",
  "Виктор": "Victor",
  "Викторович": "Viktorovich",
  "Викторовна": "Viktorovna",
  "Волков": "Volkov",
  "Волкова": "Volkova",
  "Государственный архив Республики Татарстан": "State Archive of the Republic of Tatarstan",
  "Государственный музей": "State Museum",
  "Дмитриевна": "Dmitrievna",
  "Дмитрий": "Dmitry",
  "Елена": "Elena",
  "Иванова": "Ivanova",
  "Ивановна": "Ivanovna",
  "Ильинична": "Ilyinichna",
  "Ильич": "Ilyich",
  "Илья": "Ilya",
  "Инженер-путеец": "Railway engineer",
  "Инженер-путеец. Любил фотографировать семейные праздники.": "Railway engineer. Loved photographing family celebrations.",
  "Историк, преподаватель": "Historian, teacher",
  "Исторический факультет": "Faculty of History",
  "История": "History",
  "Казанское отделение железной дороги": "Kazan Railway Division",
  "Казань": "Kazan",
  "Казань, Арское кладбище": "Kazan, Arskoe Cemetery",
  "Казань, Большая Проломная улица": "Kazan, Bolshaya Prolomnaya Street",
  "Казань, Большая Проломная улица, дом 12": "Kazan, Bolshaya Prolomnaya Street, 12",
  "Казань, улица Горького": "Kazan, Gorky Street",
  "Казань, улица Горького, дом 8, кв. 4": "Kazan, Gorky Street, 8, apt. 4",
  "Ксения": "Xenia",
  "Кузнецов": "Kuznetsov",
  "Кузнецова": "Kuznetsova",
  "Лебедев": "Lebedev",
  "Лебедева": "Lebedeva",
  "Лев": "Leo",
  "Личный архив": "Personal archive",
  "Марина": "Marina",
  "Метрические книги Казанской губернии": "Parish registers of Kazan Governorate",
  "Михаил": "Michael",
  "Михайлович": "Mikhailovich",
  "Михайловна": "Mikhailovna",
  "Морозова": "Morozova",
  "Москва": "Moscow",
  "Москва, Троекуровское кладбище": "Moscow, Troekurovskoye Cemetery",
  "Москва, район Хамовники": "Moscow, Khamovniki district",
  "Москва, улица Льва Толстого, дом 21, кв. 7": "Moscow, Leo Tolstoy Street, 21, apt. 7",
  "Московский государственный университет": "Moscow State University",
  "Московский физико-технический институт": "Moscow Institute of Physics and Technology",
  "Николаевна": "Nikolaevna",
  "Николай": "Nicholas",
  "Нина": "Nina",
  "Олег": "Oleg",
  "Олегович": "Olegovich",
  "Олеговна": "Olegovna",
  "Ольга": "Olga",
  "Орлова": "Orlova",
  "Переезд в новый район; точная дата не сохранилась.": "Moved to a new district; the exact date was not preserved.",
  "Петрович": "Petrovich",
  "Письма и фотографии": "Letters and photographs",
  "Преподаватель истории": "History teacher",
  "Призван в действующую армию.": "Called up to the active army.",
  "Прикладная математика и информатика": "Applied Mathematics and Computer Science",
  "Программист": "Programmer",
  "Пропал без вести": "Missing in action",
  "Пропал без вести зимой 1943 года.": "Missing in action in the winter of 1943.",
  "Пётр": "Peter",
  "Реставратор": "Restorer",
  "Санкт-Петербург": "Saint Petersburg",
  "Санкт-Петербург, набережная Фонтанки, дом 30": "Saint Petersburg, Fontanka Embankment, 30",
  "Свидетельство № 128": "Certificate No. 128",
  "Свидетельство № 431": "Certificate No. 431",
  "Семейный архив Волковых": "The Volkov family archive",
  "Семья Волковых": "The Volkov family",
  "Семья не получила известий о месте захоронения.": "The family never learned where he was buried.",
  "Сердечная недостаточность": "Heart failure",
  "Синтетический пример источника для демонстрации.": "Synthetic sample source for the demo.",
  "Смирнова": "Smirnova",
  "Соколова": "Sokolova",
  "Софья": "Sophia",
  "Столяр": "Carpenter",
  "Столяр, переехал в Казань перед Первой мировой войной.": "Carpenter; moved to Kazan before the First World War.",
  "Студия «Север»": "Sever Studio",
  "Татьяна": "Tatiana",
  "Троекуровское кладбище": "Troekurovskoye Cemetery",
  "Участок 4, ряд 12": "Plot 4, row 12",
  "Факультет управления и прикладной математики": "Faculty of Management and Applied Mathematics",
  "Фотографии, письма и записи семейных рассказов.": "Photographs, letters and notes from family stories.",
  "Хранитель семейного архива. Начал собирать фотографии и рассказы родных в 1990-х.": "Keeper of the family archive. Began collecting photographs and family stories in the 1990s.",
  "Школа № 15": "School No. 15",
  "по рассказам родных, 1990-е": "according to family stories, 1990s",
  "после 1943 года, место неизвестно": "after 1943, place unknown",
  "Демо: семья Волковых": "Demo: the Volkov family",
  "1901, л. 3": "1901, fol. 3",
  "1902, л. 6": "1902, fol. 6",
  "1903, л. 9": "1903, fol. 9",
  "1904, л. 12": "1904, fol. 12",
};

const untranslated = new Set();

function translate(value) {
  if (typeof value !== "string") return value;
  if (translations[value]) return translations[value];
  // Dates, enum codes and the synthetic id are structural; anything Cyrillic
  // left over is reported so the dictionary can be completed.
  if (/[\u0400-\u04FF]/.test(value)) untranslated.add(value);
  return value;
}

function translateTree(value, key = "") {
  if (typeof value === "string") return translate(value);
  if (Array.isArray(value)) return value.map((item) => translateTree(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, translateTree(item, name)]),
    );
  }
  return value;
}

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gentree-demo-en-"));
try {
  const run = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "make-demo-project.mjs"), tmp],
    { stdio: "inherit" },
  );
  if (run.status !== 0) throw new Error("the Russian demo generator failed");

  const source = path.join(tmp, SOURCE_ID);
  const target = path.join(OUT, PROJECT_ID);
  const files = [
    "persons.jsonl",
    "relationships.jsonl",
    "events.jsonl",
    "sources.jsonl",
    "citations.jsonl",
    "media.jsonl",
  ];

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, "media"), { recursive: true });

  for (const file of files) {
    const full = path.join(source, file);
    if (!fs.existsSync(full)) {
      fs.writeFileSync(path.join(target, file), "", "utf8");
      continue;
    }
    const lines = fs
      .readFileSync(full, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line);
        row.data = translateTree(row.data);
        return JSON.stringify(row);
      });
    fs.writeFileSync(path.join(target, file), lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  manifest.projectId = PROJECT_ID;
  manifest.name = translate(manifest.name);
  manifest.contentHash = contentHash(target);
  fs.writeFileSync(
    path.join(target, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  if (untranslated.size > 0) {
    console.warn(`untranslated strings: ${[...untranslated].sort().join(" | ")}`);
  }
  console.log(`english demo project: ${target}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
