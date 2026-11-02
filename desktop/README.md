# Gentree Desktop

Локальное десктопное приложение для семейного архива: Rust core + Tauri 2 +
React. Проект — папка на диске, без сервера, аккаунтов и телеметрии.

## Статус

MVP. Готово: проекты, персоны, события, связи, гражданские даты, граф предков,
путь и родство, таймлайн, поиск (Tantivy), AT5-импорт и экспорт, GEDCOM 5.5.1
(импорт и экспорт), JSON/ZIP-обмен, бэкап/restore, чат-клиент со встроенными
инструментами.

## Требования

- Windows 10/11 x64 или macOS 11+.
- Для сборки: Rust 1.88+ (`desktop/rust-toolchain.toml`), Node 20+,
  MSVC Build Tools (Windows) / Xcode CLT (macOS).

## Быстрый старт

```bash
make install
make check

make dev
```

Сборка и запуск:

```bash
make run         # release exe + запуск
make exe         # только exe, без установщиков
make build       # .msi + NSIS .exe на Windows, .dmg на macOS
```

`cargo build` напрямую не годится: без `tauri build` приложение собирается в
dev-режиме и ждёт Vite на `localhost:1420`. Подробности —
[`docs/build.md`](docs/build.md).
