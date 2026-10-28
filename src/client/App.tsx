/**
 * Lair - the dashboard: a header with the project, the command bar, the nav
 * of sections (nav.ts: only those whose module the project turns on), and
 * the section the URL names (router.ts: #/<section>[/<detail>][?tab=]).
 * Old view ids in the URL redirect to the section that replaced them.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Home } from "./components/Home";
import { Work } from "./components/Work";
import { GatesSection } from "./components/GatesSection";
import { PullRequests } from "./components/PullRequests";
import { MachinesSection } from "./components/MachinesSection";
import { DecisionsSection } from "./components/DecisionsSection";
import { Delivery } from "./components/Delivery";
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
import "./App.css";

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
      case "settings":
        // Settings (src/client/components/Settings.tsx) is keyed by project: a switch starts it afresh
        return <Settings key={currentProject} project={currentProject} refreshKey={refreshKey} />;
    }
  };

  return (
    <ChatContext.Provider value={chatControl}>
    <div className="app">
      <header className="header">
        <h1>
          <a href={linkTo("home")} className="brand">
            🐉 Lair
          </a>
        </h1>
        <div className="header-controls">
          {projects.length > 1 && (
            <select
              value={currentProject}
              onChange={(e) => switchProject(e.target.value)}
              className="project-select"
              aria-label="Project"
            >
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          <span className="last-refresh" title={lastRefresh.toLocaleString()}>
            Updated {lastRefresh.toLocaleTimeString()}
          </span>
        </div>
      </header>

      {currentProject && (
        <CommandBar
          project={currentProject}
          mode={commandMode}
          onModeChange={setCommandMode}
          readOnly={controlsStatus.readOnly}
          onAskSupervisor={askGoesToSupervisor(chatStatus.data) ? (question) => chatControl.open({ question }) : undefined}
        />
      )}

      {currentProject && chatRequest && (
        <SupervisorChatPanel
          project={currentProject}
          request={chatRequest}
          onClose={() => setChatRequest(null)}
          problem={chatStatus.data?.enabled ? chatStatus.data.problem : null}
        />
      )}

      <nav className="nav" aria-label="Sections">
        {visibleSections(modules).map((section) => (
          <a
            key={section.id}
            href={linkTo(section.id)}
            className={`nav-button ${route.section === section.id ? "active" : ""}`}
            aria-current={route.section === section.id ? "page" : undefined}
          >
            {section.label}
            {section.id === "decisions" && <DecisionsBadge refreshKey={refreshKey} />}
          </a>
        ))}
      </nav>

      <ConfigBanner refreshKey={refreshKey} />

      <main className="main">
        {modulesApi.error && !modulesApi.data && (
          <div className="error" role="alert">
            Could not read which modules {currentProject} turns on ({modulesApi.error}): only the sections every project
            has are shown.
          </div>
        )}
        {renderSection()}
      </main>

      <footer className="footer">
        <span>Lair v{LAIR_VERSION}</span>
        <span>•</span>
        <span>{readOnly ? "🔒 Read-only" : "🔓 Control"}</span>
        {controlsStatus.orchestratorPaused && (
          <>
            <span>•</span>
            <span>⏸ Paused</span>
          </>
        )}
        <ServerControls refreshKey={refreshKey} />
      </footer>
    </div>
    </ChatContext.Provider>
  );
}
