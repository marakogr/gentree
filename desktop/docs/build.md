# Сборка и запуск

Кратко: `make install` один раз, затем `make run` (собрать exe и открыть) или
`make build` (установщики).

## Требования

- Windows 10/11 x64 или macOS 11+.
- Rust 1.88+ (`desktop/rust-toolchain.toml`), Node 20+, npm.
- MSVC Build Tools + Windows SDK (Windows) или Xcode CLT (macOS).
- GNU make и git. На Windows make удобно поставить через
  `choco install make`; git даёт `grep`/`awk` и оболочку, которой пользуется make.

## Первый запуск

```bash
make install   # npm ci для desktop/ui
make check     # формат, clippy, Rust-тесты, UI typecheck/test/build/i18n
make run       # release exe + запуск
```

## Что собирает каждая команда

| Команда | Результат |
|---|---|
| `make dev` | dev-режим: Vite на `localhost:1420` + окно Tauri с hot reload |
| `make exe` | только release-бинарник, без установщиков |
| `make run` | `make exe`, затем запуск этого бинарника |
| `make build` | установщики текущей ОС: `.msi` + NSIS `.exe` на Windows, `.dmg` на macOS |
| `make portable` | портативный архив Windows: один exe в zip, без установщика |
| `make store` | MSIX для Microsoft Store: full-trust пакет без автообновления, см. `docs/store.md` |
| `make store-test` | то же, но подписано локальным тестовым сертификатом — только для проверки установки |
| `make rebuild` | `make clean` + `make build` |

Пути:

- exe: `desktop/target/release/gentree-desktop.exe` (macOS — без `.exe`);
- установщики: `desktop/target/release/bundle/msi`, `.../nsis` (macOS — `.../dmg`);
- фронтенд: `desktop/ui/dist` (собирается автоматически перед exe/установщиком).

## Почему не `cargo build`

`cargo build --release` компилирует Tauri **без** фичи `tauri/custom-protocol`,
поэтому приложение считает себя dev-сборкой и открывает `http://localhost:1420`.
Если dev-сервер не запущен, окно показывает `ERR_CONNECTION_REFUSED`.

Продакшн-сборка — только через Tauri CLI: он добавляет
`--features tauri/custom-protocol` и встраивает `desktop/ui/dist` в бинарник.
Именно это делают `make exe`, `make run` и `make build`.

Сырой `cargo build` годится только вместе с `make dev` (Vite на 1420).

## Подпись установщиков и обновления

`make build` собирает обычные установщики: артефакты обновления в
`tauri.conf.json` выключены, ключ подписи не нужен.

CI включает их оверлеем
`desktop/apps/desktop/tauri.release.conf.json`. Локально для проверки
обновлений используйте тот же оверлей и ключ в окружении:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\gentree.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "..."
cd desktop\apps\desktop
..\..\ui\node_modules\.bin\tauri.cmd build --config tauri.release.conf.json
```

Сценарий проверки обновления через локальный статический сервер (http только на
loopback) описан в [`docs/releases.md`](../../docs/releases.md).

## macOS: .dmg

`.dmg` собирается в релизном workflow на `macos-latest` (arm64) и локально через
`make build`; в релизе он появляется в draft release наравне с Windows-сборкой.

Кросс-сборка .dmg с Windows невозможна: бандлер использует `hdiutil`,
`codesign` и SDK macOS. Нужен Mac (или macOS-раннер CI).

На Mac один раз:

```bash
xcode-select --install          # Xcode CLT: make, clang, hdiutil
make install                    # npm ci
make check                      # по желанию
make build                      # .app + .dmg
```

Результат: `desktop/target/release/bundle/dmg/Gentree_0.2.0_<arch>.dmg`
(и `.../macos/Gentree.app`). Явно только dmg:

```bash
cd desktop/apps/desktop && ../../ui/node_modules/.bin/tauri build --bundles dmg
```

### Универсальный бинарник (arm64 + x64)

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cd desktop/apps/desktop
../../ui/node_modules/.bin/tauri build --target universal-apple-darwin --bundles dmg
```

Обычный `make build` на Apple Silicon даёт arm64, на Intel — x64.

### Подпись и notarization

Без сертификата dmg собирается, но Gatekeeper ругается («не удаётся проверить
разработчика»). Для локальной проверки:

```bash
xattr -dr com.apple.quarantine Gentree_0.2.0_aarch64.dmg
```

Для нормальной раздачи нужен Apple Developer ID; Tauri CLI сам подписывает и
нотаризует, если заданы переменные окружения:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="<apple-id>"
export APPLE_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="<TEAMID>"
make build
```

В CI те же значения лежат в секретах `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID` и
`APPLE_ID`/`APPLE_PASSWORD` (или `APPLE_API_*`): пока их нет, `.dmg` публикуется
неподписанным, а шаг проверки не требует подписи. Как только секреты заданы,
релиз падает при неудачном `codesign`/`spctl`/`stapler`. Подробнее —
`docs/releases.md`.

Проверить сертификаты: `security find-identity -v -p codesigning`.
Секреты не коммитить и не выводить в логи.

## Windows: особенности

- make на Windows запускает рецепты через найденную оболочку: обычно Git Bash,
  иначе `cmd.exe`. Рецепты в `Makefile` не используют `rm`, `start` и другие
  команды конкретной оболочки, поэтому работают в обеих.
- `cargo` должен быть в `PATH`. Если его нет:
  `make CARGO="C:\Users\<user>\.cargo\bin\cargo.exe" exe`.
- Пересборка падает с «Отказано в доступе», если приложение запущено: закрой
  окно (или `Stop-Process -Name gentree-desktop`) и повтори.
- Tauri CLI ставится вместе с UI-зависимостями (`make install`); отдельно
  устанавливать его не нужно.

## Портативная сборка (Windows)

```bash
make portable
```

Команда собирает `desktop/target/release/gentree-desktop.exe` с оверлеем
`desktop/apps/desktop/tauri.portable.conf.json` (пустые endpoint и pubkey
апдейтера, поэтому портативная копия не обновляет себя) и упаковывает его в
`release-assets/Gentree_<версия>_x64_portable.zip` скриптом
`scripts/package-portable.mjs`.

В архиве один `Gentree.exe` и сгенерированный `README.txt`; установщика и
самораспаковщика нет. Данные по-прежнему лежат в `%APPDATA%\Gentree`, рядом с
exe ничего не пишется. Пользовательское описание —
[`docs/portable.md`](../../docs/portable.md).

Требуется PowerShell: архив создаётся `Compress-Archive`. Цель работает только
на Windows; на macOS публикуется отдельная сборка `.dmg`.

## Проверки перед PR

```bash
make check   # quality gates
make ci      # make check + git diff --check
```
