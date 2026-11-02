import { describe, expect, it } from "vitest";
import {
  LAST_BACKUP_KEY_PREFIX,
  LAST_CHECK_KEY_PREFIX,
  backupStorageKey,
  checkStorageKey,
  formatBackupSize,
  formatBackupStamp,
  readLastBackup,
  readLastCheck,
  writeLastBackup,
  writeLastCheck,
  type BackupStorage,
} from "./backupStamp";

function memoryStorage(): BackupStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const STAMP = "2026-10-23T09:15:00.000Z";

describe("backupStorageKey", () => {
  it("namespaces by project id", () => {
    expect(backupStorageKey("p-1")).toBe(`${LAST_BACKUP_KEY_PREFIX}p-1`);
    expect(LAST_BACKUP_KEY_PREFIX).toBe("gentree.lastBackup.");
  });
});

describe("readLastBackup / writeLastBackup", () => {
  it("round-trips an ISO timestamp", () => {
    const storage = memoryStorage();
    expect(writeLastBackup("p-1", STAMP, storage)).toBe(STAMP);
    expect(storage.data.get(backupStorageKey("p-1"))).toBe(STAMP);
    expect(readLastBackup("p-1", storage)).toBe(STAMP);
  });

  it("accepts a Date and stores UTC ISO", () => {
    const storage = memoryStorage();
    const written = writeLastBackup("p-1", new Date("2026-10-23T09:15:00Z"), storage);
    expect(written).toBe(new Date("2026-10-23T09:15:00Z").toISOString());
    expect(readLastBackup("p-1", storage)).toBe(written);
  });

  it("returns null for unknown projects", () => {
    expect(readLastBackup("nope", memoryStorage())).toBeNull();
  });

  it("ignores malformed and non-ISO values", () => {
    const storage = memoryStorage();
    for (const raw of ["", "not-a-date", "2026-10-23", "23.10.2026 09:15"]) {
      storage.setItem(backupStorageKey("p-1"), raw);
      expect(readLastBackup("p-1", storage)).toBeNull();
    }
  });

  it("refuses to write an invalid value", () => {
    const storage = memoryStorage();
    expect(writeLastBackup("p-1", "not-a-date", storage)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("degrades to null without storage", () => {
    expect(writeLastBackup("p-1", STAMP, null)).toBeNull();
    expect(readLastBackup("p-1", null)).toBeNull();
  });

  it("swallows storage exceptions", () => {
    const throwing: BackupStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readLastBackup("p-1", throwing)).toBeNull();
    expect(writeLastBackup("p-1", STAMP, throwing)).toBeNull();
  });
});

describe("checkStorageKey", () => {
  it("uses its own namespace so backup and check labels never collide", () => {
    expect(checkStorageKey("p-1")).toBe(`${LAST_CHECK_KEY_PREFIX}p-1`);
    expect(LAST_CHECK_KEY_PREFIX).toBe("gentree.lastCheck.");
    expect(checkStorageKey("p-1")).not.toBe(backupStorageKey("p-1"));
  });
});

describe("readLastCheck / writeLastCheck", () => {
  it("round-trips independently from the backup stamp", () => {
    const storage = memoryStorage();
    const backup = "2026-10-23T09:15:00.000Z";
    const check = "2026-10-24T10:00:00.000Z";

    expect(writeLastBackup("p-1", backup, storage)).toBe(backup);
    expect(writeLastCheck("p-1", check, storage)).toBe(check);
    expect(readLastBackup("p-1", storage)).toBe(backup);
    expect(readLastCheck("p-1", storage)).toBe(check);
  });

  it("returns null without storage or for an invalid stamp", () => {
    expect(writeLastCheck("p-1", STAMP, null)).toBeNull();
    expect(readLastCheck("p-1", null)).toBeNull();
    expect(writeLastCheck("p-1", "not-a-date", memoryStorage())).toBeNull();
  });
});

describe("formatBackupStamp", () => {
  it("shows the em dash when the stamp is missing or invalid", () => {
    expect(formatBackupStamp(null, "en")).toBe("\u2014");
    expect(formatBackupStamp(undefined, "ru")).toBe("\u2014");
    expect(formatBackupStamp("not-a-date", "ru")).toBe("\u2014");
    expect(formatBackupStamp("2026-10-23", "ru")).toBe("\u2014");
    expect(formatBackupStamp(null, "ru", "none")).toBe("none");
  });

  it("formats a valid stamp with the requested locale", () => {
    const en = formatBackupStamp(STAMP, "en");
    const ru = formatBackupStamp(STAMP, "ru");
    expect(en).toContain("2026");
    expect(ru).toContain("2026");
    expect(en).not.toBe("\u2014");
    expect(ru).not.toBe("\u2014");
  });

  it("accepts zone offsets", () => {
    expect(formatBackupStamp("2026-10-23T12:15:00+03:00", "en")).toContain(
      "2026",
    );
  });
});

describe("formatBackupSize", () => {
  it("uses binary units and an em dash for invalid input", () => {
    expect(formatBackupSize(0)).toBe("0 B");
    expect(formatBackupSize(512)).toBe("512 B");
    expect(formatBackupSize(2048)).toBe("2 KB");
    expect(formatBackupSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBackupSize(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
    expect(formatBackupSize(-1)).toBe("\u2014");
    expect(formatBackupSize(Number.NaN)).toBe("\u2014");
  });
});
