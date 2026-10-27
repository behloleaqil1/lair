/**
 * Lair - Main App Component
 */
import { useState, useEffect } from "react";
import { Overview } from "./components/Overview";
import { Dragons } from "./components/Dragons";
import { Gates } from "./components/Gates";
import { PRs } from "./components/PRs";
import { Orchestrator } from "./components/Orchestrator";
import { Machines } from "./components/Machines";
import { Activity } from "./components/Activity";
import { Inbox } from "./components/Inbox";
import { Processes } from "./components/Processes";
import { Nodes } from "./components/Nodes";
import { Health } from "./components/Health";
import { Delivery } from "./components/Delivery";
import { Reviews } from "./components/Reviews";
import { Agents } from "./components/Agents";
import { Triage } from "./components/Triage";
import { CommandBar } from "./components/CommandBar";
import { pickInitialProject } from "./initial-project";
import type { CommandMode, ControlsStatus } from "../shared/types";
import { LAIR_VERSION } from "../shared/version";
import { DecisionInbox, DecisionsBadge } from "./components/DecisionInbox";
import { VIEWS, type View } from "./nav";
import "./App.css";

export function App() {
  const [currentView, setCurrentView] = useState<View>("overview");
  const [projects, setProjects] = useState<string[]>([]);
  const [currentProject, setCurrentProject] = useState<string>("");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [commandMode, setCommandMode] = useState<CommandMode>("ask");
  const [controlsStatus, setControlsStatus] = useState<ControlsStatus>({
    readOnly: true,
    orchestratorPaused: false,
    tickRunning: false,
  });

  // Load projects on mount, and open the server's default project (LAIR_PROJECT)
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
          const initial = pickInitialProject(data.data, await defaultProject);
          if (initial) {
            setCurrentProject(initial);
          }
        }
      })
      .catch(console.error);
  }, []);

  // Fetch controls status when project changes
  useEffect(() => {
    if (!currentProject) return;
    fetch(`/api/controls/status?project=${currentProject}`)
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

  const renderView = () => {
    const props = {
      project: currentProject,
      refreshKey: lastRefresh.getTime(),
    };

    switch (currentView) {
      case "overview":
        return <Overview {...props} />;
      case "decisions":
        return <DecisionInbox {...props} />;
      case "dragons":
        return <Dragons {...props} />;
      case "gates":
        return <Gates {...props} />;
      case "prs":
        return <PRs {...props} />;
      case "orchestrator":
        return <Orchestrator {...props} />;
      case "machines":
        return <Machines {...props} />;
      case "nodes":
        return <Nodes {...props} />;
      case "processes":
        return <Processes {...props} />;
      case "activity":
        return <Activity {...props} />;
      case "health":
        return <Health {...props} />;
      case "delivery":
        return <Delivery {...props} />;
      case "reviews":
        return <Reviews {...props} />;
      case "agents":
        return <Agents {...props} />;
      case "triage":
        return <Triage {...props} />;
      case "inbox":
        return <Inbox {...props} />;
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🐉 Lair</h1>
        <div className="header-controls">
          {projects.length > 1 && (
            <select
              value={currentProject}
              onChange={(e) => setCurrentProject(e.target.value)}
              className="project-select"
            >
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          <span className="last-refresh">
            Last refresh: {lastRefresh.toLocaleTimeString()}
          </span>
        </div>
      </header>

      {currentProject && (
        <CommandBar
          project={currentProject}
          mode={commandMode}
          onModeChange={setCommandMode}
          readOnly={controlsStatus.readOnly}
        />
      )}

      <nav className="nav">
        {VIEWS.map((view) => (
          <button
            key={view.id}
            className={`nav-button ${currentView === view.id ? "active" : ""}`}
            onClick={() => setCurrentView(view.id)}
          >
            {view.label}
            {view.id === "decisions" && <DecisionsBadge refreshKey={lastRefresh.getTime()} />}
          </button>
        ))}
      </nav>

      <main className="main">{renderView()}</main>

      <footer className="footer">
        <span>Lair v{LAIR_VERSION}</span>
        <span>•</span>
        <span>{controlsStatus.readOnly ? "🔒 Read-only" : "🔓 Control"}</span>
        {controlsStatus.orchestratorPaused && (
          <>
            <span>•</span>
            <span>⏸ Paused</span>
          </>
        )}
      </footer>
    </div>
  );
}
