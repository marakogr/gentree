.DEFAULT_GOAL := help

# GNU make on Windows runs recipes with cmd.exe regardless of SHELL, so the
# Unix shell is only requested where it actually exists.
ifneq ($(OS),Windows_NT)
SHELL := /bin/bash
endif

CARGO ?= cargo
NODE ?= node
UI := desktop/ui

# `setup`/`doctor` bootstrap guards. GNU make on Windows runs recipes with
# cmd.exe, so the guard is written in cmd syntax there.
NODE_MISSING := Node.js 20+ is required. Install it first, see README.md
ifeq ($(OS),Windows_NT)
NODE_GUARD = @$(NODE) --version 1>nul 2>nul || (echo $(NODE_MISSING) & exit /b 1)
else
NODE_GUARD = @$(NODE) --version >/dev/null 2>&1 || { echo "$(NODE_MISSING)"; exit 1; }
endif

# The Tauri CLI must run from apps/desktop; on Windows the launcher is a .cmd.
ifeq ($(OS),Windows_NT)
TAURI_APP := ../../ui/node_modules/.bin/tauri.cmd
APP_EXE := desktop/target/release/gentree-desktop.exe
else
TAURI_APP := ../../ui/node_modules/.bin/tauri
APP_EXE := desktop/target/release/gentree-desktop
endif

.PHONY: help setup doctor install fmt fmt-check lint test ui-check check ci i18n dev exe run \
	build rebuild portable clean hooks ux-setup ux-review demo-project demo-screenshots

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install React UI dependencies
	npm --prefix $(UI) ci

setup: ## One-time bootstrap: Rust toolchain, UI deps, git hooks
	$(NODE_GUARD)
	@$(NODE) scripts/setup.mjs

doctor: ## Diagnose the dev environment (Node, Rust, deps, linker)
	$(NODE_GUARD)
	@$(NODE) scripts/doctor.mjs

fmt: ## Format Rust code
	cd desktop && $(CARGO) fmt --all

fmt-check: ## Check Rust formatting
	cd desktop && $(CARGO) fmt --all -- --check

lint: ## Run clippy for the whole Rust workspace
	cd desktop && $(CARGO) clippy --workspace --all-targets -- -D warnings

test: ## Run Rust tests
	cd desktop && $(CARGO) test --workspace

ui-check: ## Typecheck, test, build and check i18n for the UI
	npm --prefix $(UI) run typecheck
	npm --prefix $(UI) run test
	npm --prefix $(UI) run build
	npm --prefix $(UI) run i18n:check

i18n: ## Check locale parity and hardcoded strings
	npm --prefix $(UI) run i18n:check

ux-setup: ## Check WebDriver prerequisites for the optional UI review
	npm --prefix $(UI) run ux:setup

ux-review: ## Run the WebdriverIO UX review against an isolated build
	npm --prefix $(UI) run ux:review

demo-project: ## Regenerate the synthetic demo project
	$(NODE) scripts/make-demo-project.mjs demo/project

demo-screenshots: ## Capture README screenshots from the demo project
	$(NODE) scripts/capture-demo-screenshots.mjs

check: fmt-check lint test ui-check ## Run all quality gates

ci: check ## Local CI: quality gates and whitespace check
	git diff --check

dev: ## Run the desktop app in dev mode
	cd desktop/apps/desktop && $(TAURI_APP) dev

exe: ## Build the release executable only (no installers)
	cd desktop/apps/desktop && $(TAURI_APP) build --no-bundle

run: exe ## Build the release executable and launch it
	@node -e "const{spawn}=require('child_process');spawn(process.argv[1],[],{detached:true,stdio:'ignore'}).unref()" "$(APP_EXE)"

build: ## Build desktop bundles for the current OS (msi/nsis or dmg)
	cd desktop/apps/desktop && $(TAURI_APP) build

rebuild: clean build ## Clean and rebuild desktop installers

portable: ## Package the portable Windows archive (no installer)
	cd desktop/apps/desktop && $(TAURI_APP) build --no-bundle --config tauri.portable.conf.json
	$(NODE) scripts/package-portable.mjs --exe $(APP_EXE) --version $(shell node -p "require('./desktop/apps/desktop/tauri.conf.json').version") --out release-assets

clean: ## Remove Rust build artifacts and the UI build output
	cd desktop && $(CARGO) clean
	node -e "require('fs').rmSync('desktop/ui/dist',{recursive:true,force:true})"

hooks: ## Enable Conventional Commits and local-only/secret/artifact pre-commit checks
	git config core.hooksPath .githooks
	-chmod +x .githooks/*
