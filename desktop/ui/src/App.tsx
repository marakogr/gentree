import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { resolveLocale, setLocale } from "./i18n";
import {
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbItem,
  Button,
  Text,
  Tooltip,
} from "@fluentui/react-components";
import {
  ArrowLeftRegular,
  BranchForkRegular,
  CalendarLtrRegular,
  ChatRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  FolderRegular,
  HistoryRegular,
  MapRegular,
  NavigationRegular,
  OrganizationRegular,
  PeopleRegular,
  QuestionCircleRegular,
  SearchRegular,
  SettingsRegular,
  type FluentIcon,
} from "@fluentui/react-icons";
import type { ProjectInfo } from "./api/types";
import { projectsApi } from "./api/client";
import ChatPage, { type ChatSeed } from "./features/chat/ChatPage";
import EventsPage from "./features/events/EventsPage";
import GraphPage from "./features/graph/GraphPage";
import HelpPage from "./features/help/HelpPage";
import MapPage from "./features/map/MapPage";
import { TourOverlay } from "./features/onboarding/TourOverlay";
import {
  adjacentStep,
  isLastStep,
  tourSteps,
  type TourStepId,
} from "./features/onboarding/steps";
import {
  markTourCompleted,
  shouldAutoStartTour,
  tourCompleted,
} from "./features/onboarding/storage";
import PathPage from "./features/path/PathPage";
import PersonsPage from "./features/persons/PersonsPage";
import {
  personNavigationTarget,
  type PersonNavigationAction,
} from "./features/persons/actions";
import ProjectsPage from "./features/projects/ProjectsPage";
import SearchPage from "./features/search/SearchPage";
import SettingsPage from "./features/settings/SettingsPage";
import TimelinePage from "./features/timeline/TimelinePage";
import { SidebarProject } from "./components/SidebarProject";
import { ToastProvider } from "./components/ui/toast";
import { AppProviders } from "./app/providers";
import {
  darkTheme,
  lightTheme,
  swissDarkTheme,
  swissLightTheme,
} from "./app/theme";
import {
  DEFAULT_PROJECT_TAB,
  activeNavId,
  backLabelKey,
  backOrigin,
  shellLocation,
  sidebarModel,
  type BackOrigin,
  type NavIcon,
  type NavItem,
  type ShellTab,
} from "./lib/navigation";
import {
  applyTheme,
  persistThemePreference,
  readStoredThemePreference,
  resolveTheme,
  resolveThemePreference,
  systemPrefersDark,
  type ThemePreference,
} from "./lib/theme";
import {
  applyStyle,
  persistStylePreference,
  readStoredStylePreference,
  resolveStylePreference,
  type StylePreference,
} from "./lib/style";
import "./styles.css";

const NAV_ICONS: Record<NavIcon, FluentIcon> = {
  projects: FolderRegular,
  persons: PeopleRegular,
  events: CalendarLtrRegular,
  map: MapRegular,
  tree: OrganizationRegular,
  relation: BranchForkRegular,
  timeline: HistoryRegular,
  search: SearchRegular,
  chat: ChatRegular,
  help: QuestionCircleRegular,
  settings: SettingsRegular,
};

export default function App() {
  const { t, i18n } = useTranslation();
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [tab, setTab] = useState<ShellTab>("projects");
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 900px)").matches;
  });
  const manualCollapse = useRef(false);
  const [back, setBack] = useState<BackOrigin | null>(null);
  const [graphRoot, setGraphRoot] = useState<string | null>(null);
  const [timelinePersonId, setTimelinePersonId] = useState<string | null>(null);
  const [personFocus, setPersonFocus] = useState<string | null>(null);
  const [eventPersonFocus, setEventPersonFocus] = useState<string | null>(null);
  /** One-shot event to reveal in the events list (validation report). */
  const [eventFocus, setEventFocus] = useState<string | null>(null);
  /** A guide question handed to the chat composer; never sent automatically. */
  const [chatSeed, setChatSeed] = useState<ChatSeed | null>(null);
  const chatSeedId = useRef(0);
  /** First-run tour: the overlay is open and the step it stopped at. */
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStepId, setTourStepId] = useState<TourStepId>("welcome");
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    () => readStoredThemePreference() ?? "system",
  );
  // The style is a second, independent axis: classic (default) or swiss.
  const [stylePreference, setStylePreference] = useState<StylePreference>(
    () => readStoredStylePreference() ?? "classic",
  );
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());

  const applyThemeChoice = useCallback((next: ThemePreference) => {
    setThemePreference(next);
    persistThemePreference(next);
  }, []);

  const applyStyleChoice = useCallback((next: StylePreference) => {
    setStylePreference(next);
    persistStylePreference(next);
  }, []);

  // Explicit themes ignore the OS; `system` follows it live.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setSystemDark(media.matches);
    apply();
    if (themePreference !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themePreference]);

  const resolvedTheme = resolveTheme(themePreference, systemDark);
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);
  useEffect(() => {
    applyStyle(stylePreference);
  }, [stylePreference]);

  const theme =
    resolvedTheme === "dark"
      ? stylePreference === "swiss"
        ? swissDarkTheme
        : darkTheme
      : stylePreference === "swiss"
        ? swissLightTheme
        : lightTheme;

  // Narrow windows collapse the sidebar to icons; a manual toggle wins until
  // the next media change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 900px)");
    const apply = () => {
      if (!manualCollapse.current) setCollapsed(media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  // The config is the persistent source of truth; the local cache only makes
  // the first paint instant (see lib/theme.ts and lib/style.ts).
  useEffect(() => {
    let active = true;
    invoke<{
      config?: {
        app?: { language?: unknown; theme?: unknown; style?: unknown };
      };
    }>("settings_get")
      .then((snapshot) => {
        if (!active) return;
        const language = snapshot?.config?.app?.language;
        if (typeof language === "string") {
          const resolved = resolveLocale(language, navigator.language);
          if (resolved !== i18n.language) void setLocale(resolved);
        }
        applyThemeChoice(
          resolveThemePreference(
            snapshot?.config?.app?.theme,
            readStoredThemePreference(),
          ),
        );
        applyStyleChoice(
          resolveStylePreference(
            snapshot?.config?.app?.style,
            readStoredStylePreference(),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [applyThemeChoice, applyStyleChoice, i18n]);

  // The tour offers itself once per installation. WebDriver sessions skip it,
  // so an automated UI review is not covered by the overlay.
  useEffect(() => {
    if (!shouldAutoStartTour(tourCompleted(), Boolean(navigator.webdriver))) {
      return;
    }
    const timer = window.setTimeout(() => setTourOpen(true), 700);
    return () => window.clearTimeout(timer);
  }, []);

  // A step can disappear when the project opens or closes: move to the first
  // step that still applies instead of showing a stale highlight.
  useEffect(() => {
    if (!tourOpen) return;
    setTourStepId((current) => {
      const steps = tourSteps(project !== null);
      if (steps.some((step) => step.id === current)) return current;
      return project !== null ? "persons" : "create";
    });
  }, [project, tourOpen]);

  const openPerson = (personId: string, origin: ShellTab = tab) => {
    const target = backOrigin(origin, "persons");
    setBack(target);
    setPersonFocus(personId);
    setTab("persons");
    setNavOpen(false);
  };

  const openEvent = (personId: string, origin: ShellTab = tab) => {
    const target = backOrigin(origin, "events");
    setBack(target);
    setEventPersonFocus(personId);
    setTab("events");
    setNavOpen(false);
  };

  // A validation issue points at an event; open the events list on that row.
  // No breadcrumb: the project page is not a place to return to per event.
  const openEventById = (eventId: string) => {
    setBack(null);
    setEventFocus(eventId);
    setTab("events");
    setNavOpen(false);
  };

  const navigatePerson = useCallback(
    (action: PersonNavigationAction, personId: string, origin: ShellTab = "persons") => {
      const target = personNavigationTarget(action, personId);
      setBack(backOrigin(origin, target.tab));
      if (target.tab === "graph") {
        setGraphRoot(target.personId);
        setTab("graph");
      } else {
        setTimelinePersonId(target.personId);
        setTab("timeline");
      }
    },
    [],
  );

  // A manual tab change drops the one-shot focus and the breadcrumb.
  const selectTab = (next: ShellTab) => {
    setBack(null);
    if (next !== tab) {
      if (next === "graph") setGraphRoot(null);
      if (next === "timeline") setTimelinePersonId(null);
      if (next === "events") setEventFocus(null);
    }
    setTab(next);
    setNavOpen(false);
  };

  const goBack = () => {
    if (!back) return;
    const target = back;
    setBack(null);
    setPersonFocus(null);
    setEventPersonFocus(null);
    setTab(target);
  };

  // The guide explains the screens; following a link keeps a way back to it.
  const openFromHelp = (target: ShellTab) => {
    setBack(backOrigin("help", target));
    if (target === "graph") setGraphRoot(null);
    if (target === "timeline") setTimelinePersonId(null);
    setTab(target);
    setNavOpen(false);
  };

  // Prefills the composer and switches to chat. Sending stays a separate,
  // explicit action so no question leaves the machine on its own.
  const askAssistant = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    chatSeedId.current += 1;
    setChatSeed({ id: `help-${chatSeedId.current}`, text: trimmed });
    setTab("chat");
    setNavOpen(false);
  }, []);

  const clearChatSeed = useCallback(() => setChatSeed(null), []);

  const startTour = useCallback(() => {
    setTourStepId("welcome");
    setTourOpen(true);
  }, []);

  const closeTour = useCallback(() => {
    markTourCompleted();
    setTourOpen(false);
  }, []);

  const nextTourStep = useCallback(() => {
    const steps = tourSteps(project !== null);
    const next = adjacentStep(steps, tourStepId, 1);
    if (next) setTourStepId(next.id);
    else if (isLastStep(steps, tourStepId)) closeTour();
  }, [project, tourStepId, closeTour]);

  const backTourStep = useCallback(() => {
    const steps = tourSteps(project !== null);
    const previous = adjacentStep(steps, tourStepId, -1);
    if (previous) setTourStepId(previous.id);
  }, [project, tourStepId]);

  const closeProject = async () => {
    await projectsApi.close();
    setProject(null);
    setBack(null);
    setTab("projects");
  };

  const model = sidebarModel(project !== null);
  const activeNav = activeNavId(shellLocation(tab));

  // The tour list changes with the project, so the current step is looked up by
  // id and the screen it needs is opened whenever the step changes.
  const tourList = tourSteps(project !== null);
  const tourStep =
    tourList.find((step) => step.id === tourStepId) ?? tourList[0];
  const tourIndex = Math.max(
    0,
    tourList.findIndex((step) => step.id === tourStep.id),
  );
  const tourScreen = tourStep.screen;
  useEffect(() => {
    if (!tourOpen || !tourScreen) return;
    setBack(null);
    setTab(tourScreen);
    setNavOpen(false);
  }, [tourOpen, tourStepId, tourScreen]);

  const renderNavItem = (item: NavItem) => {
    const Icon = NAV_ICONS[item.icon];
    const label = t(item.labelKey);
    const active = activeNav === item.id;
    const navButton = (
      <Button
        key={item.id}
        appearance="subtle"
        size={collapsed ? "small" : "medium"}
        className="sidebar-nav-item"
        data-tour={`nav-${item.id}`}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? label : undefined}
        icon={<Icon fontSize={collapsed ? 18 : 20} aria-hidden="true" />}
        onClick={() => selectTab(item.id)}
      >
        {collapsed ? null : <span className="sidebar-nav-label">{label}</span>}
      </Button>
    );
    // The rail has no room for labels, so the name moves into a tooltip.
    return collapsed ? (
      <Tooltip key={item.id} content={label} relationship="label" withArrow>
        {navButton}
      </Tooltip>
    ) : (
      navButton
    );
  };

  const backText = back ? t(`common:${backLabelKey(back)}`) : "";

  return (
    <AppProviders theme={theme}>
      <ToastProvider closeLabel={t("common:actions.close")}>
      <main className={collapsed ? "shell sidebar-collapsed" : "shell"}>
        <div className="content">
          {back && tab !== back ? (
            <Breadcrumb
              className="app-breadcrumb"
              size="small"
              aria-label={t("common:app.back")}
            >
              <BreadcrumbItem>
                <BreadcrumbButton
                  icon={<ArrowLeftRegular fontSize={20} aria-hidden="true" />}
                  onClick={goBack}
                >
                  {backText}
                </BreadcrumbButton>
              </BreadcrumbItem>
            </Breadcrumb>
          ) : null}

          {tab === "projects" ? (
            <ProjectsPage
              current={project}
              onRenamed={(renamed) =>
                setProject((current) =>
                  current?.projectId === renamed.projectId ? renamed : current,
                )
              }
              onOpened={(opened) => {
                setProject(opened);
                setBack(null);
                setTab("persons");
              }}
              onClosed={() => {
                setProject(null);
                setBack(null);
              }}
              onOpenEvent={openEventById}
            />
          ) : null}

          {tab === "persons" ? (
            project ? (
              <PersonsPage
                projectId={project.projectId}
                homePersonId={project.homePersonId}
                focusPersonId={personFocus}
                onFocusHandled={() => setPersonFocus(null)}
                onNavigate={navigatePerson}
              />
            ) : (
              <section className="panel">
                <p className="meta">{t("app.noProject")}</p>
              </section>
            )
          ) : null}

          {tab === "graph" ? (
            project ? (
              <GraphPage
                projectId={project.projectId}
                homePersonId={project.homePersonId}
                initialRootPersonId={graphRoot}
                onRootHandled={() => setGraphRoot(null)}
                onHomeChanged={(homePersonId) =>
                  setProject((current) =>
                    current ? { ...current, homePersonId } : current,
                  )
                }
                onNavigate={(action, personId) =>
                  navigatePerson(action, personId, "graph")
                }
              />
            ) : (
              <section className="panel">
                <p className="meta">{t("app.noProject")}</p>
              </section>
            )
          ) : null}

          {tab === "path" ? (
            project ? (
              <PathPage
                projectId={project.projectId}
                onOpenInGraph={(personId) => {
                  setGraphRoot(personId);
                  setBack("path");
                  setTab("graph");
                }}
                onNavigate={(action, personId) =>
                  navigatePerson(action, personId, "path")
                }
              />
            ) : (
              <section className="panel">
                <p className="meta">{t("app.noProject")}</p>
              </section>
            )
          ) : null}

          {tab === "events" ? (
            project ? (
              <EventsPage
                projectId={project.projectId}
                focusPersonId={eventPersonFocus}
                onFocusHandled={() => setEventPersonFocus(null)}
                focusEventId={eventFocus}
                onEventFocusHandled={() => setEventFocus(null)}
                onOpenPerson={(personId) => openPerson(personId, "events")}
                onRequestNewPerson={() => selectTab("persons")}
                onValidateData={() => selectTab("projects")}
              />
            ) : (
              <section className="panel">
                <p className="meta">{t("app.noProject")}</p>
              </section>
            )
          ) : null}

          {tab === "map" ? (
            project ? (
              <MapPage
                key={project.projectId}
                projectId={project.projectId}
                onOpenPerson={(personId) => openPerson(personId, "map")}
              />
            ) : (
              <section className="panel">
                <p className="meta">{t("app.noProject")}</p>
              </section>
            )
          ) : null}

          {tab === "timeline" ? (
            project ? (
              <TimelinePage
                key={`${project.projectId}:${timelinePersonId ?? "all"}`}
                projectId={project.projectId}
                projectName={project.name}
                initialScope={timelinePersonId ? "person" : "all"}
                initialPersonId={timelinePersonId}
                onOpenPerson={(personId) => openPerson(personId, "timeline")}
              />
            ) : (
              <section className="panel">
                <p className="meta">{t("app.noProject")}</p>
              </section>
            )
          ) : null}

          {tab === "search" ? (
            project ? (
              <SearchPage
                projectId={project.projectId}
                onOpenPerson={(personId) => openPerson(personId, "search")}
                onOpenEvent={(personId) => {
                  if (personId === null) {
                    setBack(backOrigin("search", "events"));
                    setTab("events");
                    return;
                  }
                  openEvent(personId, "search");
                }}
              />
            ) : (
              <section className="panel">
                <p className="meta">{t("app.noProject")}</p>
              </section>
            )
          ) : null}

          {/* Chat stays mounted while hidden so history survives tab switches,
              but the project id is its key: another project starts a fresh
              transcript instead of keeping the previous project's messages. */}
          <div hidden={tab !== "chat"}>
            <ChatPage
              key={project?.projectId ?? "no-project"}
              active={tab === "chat"}
              projectId={project?.projectId}
              seed={chatSeed}
              onSeedHandled={clearChatSeed}
              onOpenSettings={() => selectTab("settings")}
              onOpenPerson={(personId) => openPerson(personId, "chat")}
            />
          </div>

          {tab === "help" ? (
            <HelpPage
              projectOpen={project !== null}
              onNavigate={openFromHelp}
              onAskAssistant={askAssistant}
              onStartTour={startTour}
            />
          ) : null}

          {tab === "settings" ? (
            <SettingsPage
              onClose={() => selectTab("projects")}
              onOpenHelp={() => selectTab("help")}
              onThemeChange={applyThemeChoice}
              onStyleChange={applyStyleChoice}
            />
          ) : null}
        </div>

        <aside className="sidebar">
          <Button
            appearance="subtle"
            size="small"
            className="sidebar-collapse-edge"
            aria-label={collapsed ? t("app.expand") : t("app.collapse")}
            title={collapsed ? t("app.expand") : t("app.collapse")}
            aria-expanded={!collapsed}
            icon={
              collapsed ? (
                <ChevronRightRegular fontSize={16} aria-hidden="true" />
              ) : (
                <ChevronLeftRegular fontSize={16} aria-hidden="true" />
              )
            }
            onClick={() => {
              manualCollapse.current = true;
              setCollapsed((current) => !current);
            }}
          />
          <div className="sidebar-head">
            <Text as="span" weight="bold" size={400} className="app-brand">
              {t("app.title")}
            </Text>
            <Button
              appearance="subtle"
              size="small"
              className="sidebar-menu-toggle"
              aria-controls="app-sidebar-nav"
              aria-expanded={navOpen}
              aria-label={t("app.menu")}
              title={t("app.menu")}
              icon={<NavigationRegular fontSize={20} aria-hidden="true" />}
              onClick={() => setNavOpen((current) => !current)}
            />
          </div>

          <nav
            id="app-sidebar-nav"
            className={navOpen ? "sidebar-nav open" : "sidebar-nav"}
            aria-label={t("app.navLabel")}
          >
            {project ? (
              <SidebarProject
                project={project}
                collapsed={collapsed}
                onRenamed={(renamed) => setProject(renamed)}
                onClose={closeProject}
                onRestored={(restored) => {
                  setProject(restored);
                  setBack(null);
                  setTab(DEFAULT_PROJECT_TAB);
                }}
              >
                {model.project.map(renderNavItem)}
              </SidebarProject>
            ) : null}

            <div className="sidebar-group">{model.global.map(renderNavItem)}</div>

            <div className="sidebar-footer">
              {model.footer.map(renderNavItem)}
            </div>
          </nav>
        </aside>
      </main>
      <TourOverlay
        open={tourOpen}
        step={tourStep}
        index={tourIndex}
        total={tourList.length}
        projectOpen={project !== null}
        onNext={nextTourStep}
        onBack={backTourStep}
        onClose={closeTour}
      />
      </ToastProvider>
    </AppProviders>
  );
}
