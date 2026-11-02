/**
 * Lair - the dashboard, on the component kit (src/client/ui/): a left nav
 * with the project switcher at the top, the sections (nav.ts: only those
 * whose module the project turns on), and Lair's status, the owner's
 * state and the look (theme, density) at the bottom; the command bar above
 * the section the URL names (router.ts: #/<section>[/<detail>][?tab=]).
 * On a narrow screen the nav folds away behind the Menu button. Old view
 * ids in the URL redirect to the section that replaced them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Home } from "./components/Home";
import { Work } from "./components/Work";
import { GatesSection } from "./components/GatesSection";
import { PullRequests } from "./components/PullRequests";
import { MachinesSection } from "./components/MachinesSection";
import { DecisionsSection } from "./components/DecisionsSection";
import { Delivery } from "./components/Delivery";
import { Knowledge } from "./components/Knowledge";
import { Processes } from "./components/Processes";
import { Settings } from "./components/Settings";
import { CommandBar } from "./components/CommandBar";
import { pickInitialProject } from "./initial-project";
import type { CommandMode, ControlsStatus } from "../shared/types";
import type { DashboardModules } from "../shared/dashboard-types";
import { LAIR_VERSION } from "../shared/version";
import { DecisionsBadge } from "./components/DecisionInbox";
import { sectionAvailable, sectionDef, visibleSections } from "./nav";
import { linkTo, parseRoute, redirectFor, routeHash, type Route } from "./router";
import { useApi } from "./hooks/useApi";
import { ConfigBanner } from "./components/ConfigBanner";
import { ServerControls } from "./components/ServerControls";
import { ModuleOff, useOwnerSignedIn } from "./components/ui";
import type { SectionProps } from "./components/Section";
import { ChatContext, SupervisorChatPanel, type ChatRequest } from "./components/SupervisorChat";
import { askGoesToSupervisor } from "./supervisor-chat";
import type { ChatStatusView } from "../shared/supervisor-types";
import { Button } from "./ui/Button";
import { Callout } from "./ui/Card";
import { Field } from "./ui/Field";
import { Icon } from "./ui/Icon";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";
import { ToastProvider } from "./ui/Toast";
import { usePreferences, type ThemeChoice } from "./ui/preferences";
import "./ui/tokens.css";
import "./ui/base.css";
import "./ui/kit.css";
import "./App.css";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Follow the location hash: canonical routes only (old view ids are replaced in place). */
function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const sync = () => {
      const redirect = redirectFor(window.location.hash);
      if (redirect) window.history.replaceState(null, "", redirect);
      setRoute(parseRoute(window.location.hash));
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const go = useCallback((next: Route) => {
    const hash = routeHash(next);
    if (hash !== window.location.hash) window.location.hash = hash;
  }, []);
  return [route, go];
}

export function App() {
  const [route, go] = useRoute();
  const [projects, setProjects] = useState<string[]>([]);
  const [currentProject, setCurrentProject] = useState<string>("");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [commandMode, setCommandMode] = useState<CommandMode>("ask");
  const [controlsStatus, setControlsStatus] = useState<ControlsStatus>({
    readOnly: true,
    orchestratorPaused: false,
    tickRunning: false,
  });
  const refreshKey = lastRefresh.getTime();
  const [prefs, setPrefs] = usePreferences();
  // The nav on a narrow screen: folded until the Menu button opens it; Esc or a pick closes it
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setNavOpen(false);
      menuRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // Load projects on mount: the one the URL names, else the server's default (LAIR_PROJECT)
  useEffect(() => {
    const defaultProject = fetch("/api/projects/default")
      .then((res) => res.json())
      .then((data) => (data.success ? data.data : undefined))
      .catch(() => undefined);
    fetch("/api/projects")
      .then((res) => res.json())
      .then(async (data) => {
        if (data.success && data.data) {
          setProjects(data.data);
          const named = parseRoute(window.location.hash).project;
          const initial = named && data.data.includes(named) ? named : pickInitialProject(data.data, await defaultProject);
          if (initial) setCurrentProject(initial);
        }
      })
      .catch(console.error);
  }, []);

  // A URL that names another known project switches to it; with several projects, the URL always names one
  useEffect(() => {
    if (!currentProject || projects.length < 2) return;
    if (route.project && route.project !== currentProject && projects.includes(route.project)) {
      setCurrentProject(route.project);
    } else if (route.project !== currentProject) {
      window.history.replaceState(null, "", routeHash({ ...route, project: currentProject }));
    }
  }, [route, currentProject, projects]);

  // Fetch controls status when project changes
  useEffect(() => {
    if (!currentProject) return;
    fetch(`/api/controls/status?project=${encodeURIComponent(currentProject)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.data) {
          setControlsStatus(data.data);
        }
      })
      .catch(console.error);
  }, [currentProject, lastRefresh]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setLastRefresh(new Date());
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const modulesApi = useApi<DashboardModules>("/dashboard/modules", currentProject, refreshKey, { skip: !currentProject });
  const modules = modulesApi.data?.modules ?? null;
  const readOnly = modulesApi.data?.readOnly ?? controlsStatus.readOnly;

  // Ask Lair: with the supervisor's chat on, the Ask tab and Home's card open the chat panel (read once a minute)
  const slowKey = Math.floor(refreshKey / 60_000);
  const signedIn = useOwnerSignedIn(slowKey);
  const chatStatus = useApi<ChatStatusView>("/supervisor/chat", currentProject, slowKey, {
    owner: true,
    skip: !currentProject || signedIn !== true,
  });
  const [chatRequest, setChatRequest] = useState<ChatRequest | null>(null);
  const chatControl = useMemo(() => ({ open: (request: ChatRequest) => setChatRequest({ ...request }) }), []);

  const switchProject = (project: string) => {
    setCurrentProject(project);
    go({ section: route.section, tab: route.tab, detail: null, project: projects.length > 1 ? project : null });
  };

  const renderSection = () => {
    if (!currentProject) return null;
    const def = sectionDef(route.section);
    if (modules && !sectionAvailable(route.section, modules)) {
      return <ModuleOff what={def.label} enable={def.enable} />;
    }
    const props: SectionProps = {
      project: currentProject,
      refreshKey,
      route,
      modules,
      readOnly,
      open: (detail) => go({ ...route, detail }),
    };
    switch (route.section) {
      case "home":
        return <Home {...props} />;
      case "work":
        return <Work {...props} />;
      case "gates":
        return <GatesSection {...props} />;
      case "prs":
        return <PullRequests {...props} />;
      case "machines":
        return <MachinesSection {...props} />;
      case "decisions":
        return <DecisionsSection {...props} />;
      case "delivery":
        return <Delivery project={currentProject} refreshKey={refreshKey} />;
      case "processes":
        return <Processes project={currentProject} refreshKey={refreshKey} />;
      case "knowledge":
        return <Knowledge {...props} />;
      case "settings":
        // Settings (src/client/components/Settings.tsx) is keyed by project: a switch starts it afresh. Its pages are
        // the URL's tab, so moving between them keeps the draft
        return <Settings key={currentProject} project={currentProject} refreshKey={refreshKey} route={route} go={go} />;
    }
  };

  return (
    <ChatContext.Provider value={chatControl}>
      <ToastProvider>
        <div className="app-shell" data-nav-open={navOpen ? "true" : "false"}>
          <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>
            Skip to content
          </button>

          <aside className="sidebar" id="lair-sidebar" aria-label="Lair">
            <div className="sidebar-top">
              <h1 className="brand-heading">
                <a href={linkTo("home")} className="brand" onClick={() => setNavOpen(false)}>
                  <img src="/dragon.svg" alt="" width={22} height={22} />
                  Lair
                </a>
              </h1>
              {projects.length > 1 && (
                <Field label="Project" className="project-field">
                  <Select
                    value={currentProject}
                    onChange={(e) => switchProject(e.target.value)}
                    className="project-select"
                    options={projects.map((p) => ({ value: p, label: p }))}
                  />
                </Field>
              )}
              {projects.length === 1 && currentProject && (
                <div className="project-name" title="Project">
                  {currentProject}
                </div>
              )}
            </div>

            <nav className="nav" aria-label="Sections">
              {visibleSections(modules).map((section) => (
                <a
                  key={section.id}
                  href={linkTo(section.id)}
                  className={`nav-link${route.section === section.id ? " active" : ""}`}
                  aria-current={route.section === section.id ? "page" : undefined}
                  onClick={() => setNavOpen(false)}
                >
                  <span>{section.label}</span>
                  {section.id === "decisions" && <DecisionsBadge refreshKey={refreshKey} />}
                </a>
              ))}
            </nav>

            <footer className="footer sidebar-footer">
              <ul className="status-lines" aria-label="Lair status">
                <li>
                  <Icon name={readOnly ? "lock" : "unlock"} />
                  {readOnly ? "Read-only" : "Control"}
                </li>
                {controlsStatus.orchestratorPaused && (
                  <li>
                    <Icon name="pause" />
                    Paused
                  </li>
                )}
                {signedIn !== null && (
                  <li data-owner-state={signedIn ? "signed-in" : "signed-out"}>
                    <Icon name="user" />
                    {signedIn ? (
                      "Signed in as the owner"
                    ) : (
                      <span>
                        Not signed in as the owner · <a href={linkTo("decisions")}>Sign in</a>
                      </span>
                    )}
                  </li>
                )}
              </ul>
              <ServerControls refreshKey={refreshKey} />
              <div className="preferences">
                <Field label="Theme" className="preference-field">
                  <Select
                    compact
                    value={prefs.theme}
                    onChange={(e) => setPrefs({ theme: e.target.value as ThemeChoice })}
                    options={THEME_OPTIONS}
                  />
                </Field>
                <Switch
                  label="Compact"
                  description="Denser rows, for big fleets"
                  checked={prefs.density === "compact"}
                  onChange={(on) => setPrefs({ density: on ? "compact" : "comfortable" })}
                />
              </div>
              <div className="footer-meta">
                <span>Lair v{LAIR_VERSION}</span>
                <span className="last-refresh" title={lastRefresh.toLocaleString()}>
                  Updated {lastRefresh.toLocaleTimeString()}
                </span>
              </div>
            </footer>
          </aside>
          {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

          <div className="app-body">
            <header className="topbar">
              <Button
                variant="ghost"
                className="menu-button icon-button"
                aria-label="Menu"
                aria-expanded={navOpen}
                aria-controls="lair-sidebar"
                onClick={() => setNavOpen(!navOpen)}
                ref={menuRef}
              >
                <Icon name="menu" size={20} />
              </Button>
              {currentProject && (
                <CommandBar
                  project={currentProject}
                  mode={commandMode}
                  onModeChange={setCommandMode}
                  readOnly={controlsStatus.readOnly}
                  onAskSupervisor={askGoesToSupervisor(chatStatus.data) ? (question) => chatControl.open({ question }) : undefined}
                />
              )}
            </header>

            <ConfigBanner refreshKey={refreshKey} />

            <main className="main" id="main" tabIndex={-1} ref={mainRef}>
              {modulesApi.error && !modulesApi.data && (
                <Callout tone="danger" alert className="error">
                  Could not read which modules {currentProject} turns on ({modulesApi.error}): only the sections every
                  project has are shown.
                </Callout>
              )}
              {renderSection()}
            </main>
          </div>

          {currentProject && chatRequest && (
            <SupervisorChatPanel
              project={currentProject}
              request={chatRequest}
              onClose={() => setChatRequest(null)}
              problem={chatStatus.data?.enabled ? chatStatus.data.problem : null}
            />
          )}
        </div>
      </ToastProvider>
    </ChatContext.Provider>
  );
}
