/**
 * Settings view - configure project, toggle controls, manage dragons/models/machines
 */
import { useState, useEffect } from "react";
import type {
  ProjectConfig,
  DragonConfig,
  AIModel,
  MachineConfig,
  AgentAdapter,
} from "../../shared/types";

interface Props {
  project: string;
  refreshKey: number;
  onConfigChange?: () => void;
}

interface SettingsData {
  config: ProjectConfig;
  configPath: string;
  availableAdapters: AgentAdapter[];
}

export function Settings({ project, refreshKey, onConfigChange }: Props) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Editable state
  const [readOnly, setReadOnly] = useState(true);
  const [dragons, setDragons] = useState<Record<string, Omit<DragonConfig, "id">>>({});
  const [models, setModels] = useState<AIModel[]>([]);
  const [machines, setMachines] = useState<Record<string, MachineConfig>>({});
  const [defaultInstructions, setDefaultInstructions] = useState("");

  // Dialog state
  const [showAddDragon, setShowAddDragon] = useState(false);
  const [showAddModel, setShowAddModel] = useState(false);
  // Machine addition dialog - to be implemented in future phase
  const [editingDragon, setEditingDragon] = useState<string | null>(null);
  const [editingMachine, setEditingMachine] = useState<string | null>(null);

  // Load settings
  useEffect(() => {
    setLoading(true);
    fetch(`/api/settings?project=${encodeURIComponent(project)}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.success && result.data) {
          setData(result.data);
          setReadOnly(result.data.config.read_only ?? true);
          setDragons(result.data.config.dragons || {});
          setModels(result.data.config.available_models || []);
          setMachines(result.data.config.machines || {});
          setDefaultInstructions(result.data.config.default_instructions || "");
        } else {
          setError(result.error || "Failed to load settings");
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [project, refreshKey]);

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);

    try {
      const response = await fetch(
        `/api/settings?project=${encodeURIComponent(project)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            read_only: readOnly,
            dragons,
            available_models: models,
            machines,
            default_instructions: defaultInstructions,
          }),
        }
      );

      const result = await response.json();
      if (result.success) {
        setSaveMessage("Settings saved successfully!");
        onConfigChange?.();
      } else {
        setSaveMessage(`Error: ${result.error}`);
      }
    } catch (e) {
      setSaveMessage(`Error: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleReadOnly = () => {
    setReadOnly(!readOnly);
  };

  // Dragon management
  const handleAddDragon = (id: string, config: Omit<DragonConfig, "id">) => {
    setDragons({ ...dragons, [id]: config });
    setShowAddDragon(false);
  };

  const handleUpdateDragon = (id: string, config: Omit<DragonConfig, "id">) => {
    setDragons({ ...dragons, [id]: config });
    setEditingDragon(null);
  };

  const handleDeleteDragon = (id: string) => {
    const newDragons = { ...dragons };
    delete newDragons[id];
    setDragons(newDragons);
  };

  // Model management
  const handleAddModel = (model: AIModel) => {
    setModels([...models, model]);
    setShowAddModel(false);
  };

  const handleDeleteModel = (id: string) => {
    setModels(models.filter((m) => m.id !== id));
  };

  // Machine management
  const handleUpdateMachine = (id: string, config: MachineConfig) => {
    setMachines({ ...machines, [id]: config });
    setEditingMachine(null);
  };

  if (loading) return <div className="loading">Loading settings...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  const hasChanges =
    readOnly !== (data.config.read_only ?? true) ||
    JSON.stringify(dragons) !== JSON.stringify(data.config.dragons || {}) ||
    JSON.stringify(models) !== JSON.stringify(data.config.available_models || []) ||
    JSON.stringify(machines) !== JSON.stringify(data.config.machines || {}) ||
    defaultInstructions !== (data.config.default_instructions || "");

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1.5rem",
        }}
      >
        <h2>Settings</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {saveMessage && (
            <span
              style={{
                color: saveMessage.startsWith("Error") ? "var(--error)" : "var(--success)",
                marginRight: "1rem",
              }}
            >
              {saveMessage}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "4px",
              border: "none",
              background: hasChanges ? "var(--primary)" : "var(--border)",
              color: "white",
              cursor: hasChanges ? "pointer" : "not-allowed",
            }}
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>

      {/* Controls Section */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <h3>Controls</h3>
        <div style={{ marginTop: "1rem" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={!readOnly}
              onChange={handleToggleReadOnly}
              style={{ width: "1.25rem", height: "1.25rem" }}
            />
            <div>
              <div style={{ fontWeight: 500 }}>Enable Controls</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                Allow starting/stopping dragons, submitting gates, merging PRs, and other control actions.
                When disabled, Lair is read-only.
              </div>
            </div>
          </label>
        </div>

        <div
          style={{
            marginTop: "1rem",
            padding: "0.75rem",
            background: readOnly ? "rgba(233, 69, 96, 0.1)" : "rgba(0, 200, 83, 0.1)",
            borderRadius: "4px",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span style={{ fontSize: "1.25rem" }}>{readOnly ? "🔒" : "🔓"}</span>
          <span>
            {readOnly
              ? "Controls are DISABLED — Lair is in read-only mode"
              : "Controls are ENABLED — you can manage dragons, gates, and merges"}
          </span>
        </div>
      </div>

      {/* Dragons Section */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h3>Dragons ({Object.keys(dragons).length})</h3>
          <button
            onClick={() => setShowAddDragon(true)}
            style={{
              padding: "0.25rem 0.75rem",
              borderRadius: "4px",
              border: "1px solid var(--primary)",
              background: "transparent",
              color: "var(--primary)",
              cursor: "pointer",
            }}
          >
            + Add Dragon
          </button>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
          Configure dragons to enable Start/Stop controls and model selection in the Dragons view.
        </p>

        {Object.keys(dragons).length === 0 ? (
          <div
            style={{
              marginTop: "1rem",
              padding: "2rem",
              textAlign: "center",
              background: "var(--bg-secondary)",
              borderRadius: "4px",
            }}
          >
            <p style={{ color: "var(--text-secondary)" }}>No dragons configured.</p>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
              Add dragons to enable the Start/Stop buttons in the Dragons view.
            </p>
          </div>
        ) : (
          <table className="table" style={{ marginTop: "1rem" }}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Adapter</th>
                <th>Model</th>
                <th>Machine</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(dragons).map(([id, dragon]) => (
                <tr key={id}>
                  <td><code>{id}</code></td>
                  <td>{dragon.name}</td>
                  <td>
                    <span className="badge badge-neutral">{dragon.adapter || "kiro"}</span>
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>{dragon.model || "-"}</td>
                  <td style={{ color: "var(--text-secondary)" }}>{dragon.machine || "-"}</td>
                  <td>
                    <button
                      onClick={() => setEditingDragon(id)}
                      style={{
                        marginRight: "0.5rem",
                        padding: "0.25rem 0.5rem",
                        borderRadius: "4px",
                        border: "1px solid var(--border)",
                        background: "transparent",
                        cursor: "pointer",
                      }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteDragon(id)}
                      style={{
                        padding: "0.25rem 0.5rem",
                        borderRadius: "4px",
                        border: "1px solid var(--error)",
                        background: "transparent",
                        color: "var(--error)",
                        cursor: "pointer",
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Models Section */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h3>Available Models ({models.length})</h3>
          <button
            onClick={() => setShowAddModel(true)}
            style={{
              padding: "0.25rem 0.75rem",
              borderRadius: "4px",
              border: "1px solid var(--primary)",
              background: "transparent",
              color: "var(--primary)",
              cursor: "pointer",
            }}
          >
            + Add Model
          </button>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
          Define AI models that can be selected when starting a dragon.
        </p>

        {models.length === 0 ? (
          <div
            style={{
              marginTop: "1rem",
              padding: "2rem",
              textAlign: "center",
              background: "var(--bg-secondary)",
              borderRadius: "4px",
            }}
          >
            <p style={{ color: "var(--text-secondary)" }}>No models configured.</p>
          </div>
        ) : (
          <table className="table" style={{ marginTop: "1rem" }}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Description</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id}>
                  <td><code>{model.id}</code></td>
                  <td>{model.name}</td>
                  <td style={{ color: "var(--text-secondary)" }}>{model.description || "-"}</td>
                  <td>
                    <button
                      onClick={() => handleDeleteModel(model.id)}
                      style={{
                        padding: "0.25rem 0.5rem",
                        borderRadius: "4px",
                        border: "1px solid var(--error)",
                        background: "transparent",
                        color: "var(--error)",
                        cursor: "pointer",
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Machines Section */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <h3>Machines ({Object.keys(machines).length})</h3>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
          Configure machines for running gates and dragons.
        </p>

        <table className="table" style={{ marginTop: "1rem" }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Type</th>
              <th>Host</th>
              <th>Runners</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(machines).map(([id, machine]) => (
              <tr key={id}>
                <td><code>{id}</code></td>
                <td>{machine.name}</td>
                <td>
                  <span className={`badge ${machine.type === "local" ? "badge-success" : "badge-neutral"}`}>
                    {machine.type}
                  </span>
                </td>
                <td style={{ color: "var(--text-secondary)" }}>
                  {machine.type === "ssh" ? `${machine.user}@${machine.host}` : "localhost"}
                </td>
                <td>{machine.runners?.join(", ") || "-"}</td>
                <td>
                  <button
                    onClick={() => setEditingMachine(id)}
                    style={{
                      padding: "0.25rem 0.5rem",
                      borderRadius: "4px",
                      border: "1px solid var(--border)",
                      background: "transparent",
                      cursor: "pointer",
                    }}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Default Instructions Section */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <h3>Default Instructions</h3>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
          Instructions prepended to every dragon's prompt.
        </p>
        <textarea
          value={defaultInstructions}
          onChange={(e) => setDefaultInstructions(e.target.value)}
          placeholder="Enter default instructions for all dragons..."
          style={{
            width: "100%",
            minHeight: "100px",
            marginTop: "0.75rem",
            padding: "0.75rem",
            borderRadius: "4px",
            border: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            color: "var(--text-primary)",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            resize: "vertical",
          }}
        />
      </div>

      {/* Config Path Info */}
      <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
        Config file: <code>{data.configPath}</code>
      </div>

      {/* Dialogs */}
      {showAddDragon && (
        <DragonDialog
          adapters={data.availableAdapters}
          models={models}
          machines={Object.keys(machines)}
          onSave={handleAddDragon}
          onClose={() => setShowAddDragon(false)}
        />
      )}

      {editingDragon && (
        <DragonDialog
          id={editingDragon}
          initial={dragons[editingDragon]}
          adapters={data.availableAdapters}
          models={models}
          machines={Object.keys(machines)}
          onSave={(id, config) => handleUpdateDragon(id, config)}
          onClose={() => setEditingDragon(null)}
        />
      )}

      {showAddModel && (
        <ModelDialog onSave={handleAddModel} onClose={() => setShowAddModel(false)} />
      )}

      {editingMachine && (
        <MachineDialog
          id={editingMachine}
          initial={machines[editingMachine]}
          onSave={handleUpdateMachine}
          onClose={() => setEditingMachine(null)}
        />
      )}
    </div>
  );
}

// Dragon Dialog
interface DragonDialogProps {
  id?: string;
  initial?: Omit<DragonConfig, "id">;
  adapters: AgentAdapter[];
  models: AIModel[];
  machines: string[];
  onSave: (id: string, config: Omit<DragonConfig, "id">) => void;
  onClose: () => void;
}

function DragonDialog({ id, initial, adapters, models, machines, onSave, onClose }: DragonDialogProps) {
  const [dragonId, setDragonId] = useState(id || "");
  const [name, setName] = useState(initial?.name || "");
  const [adapter, setAdapter] = useState(initial?.adapter || "kiro");
  const [model, setModel] = useState(initial?.model || "");
  const [machine, setMachine] = useState(initial?.machine || "");
  const [instructions, setInstructions] = useState(initial?.instructions || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dragonId || !name) return;
    onSave(dragonId, { name, adapter, model, machine, instructions });
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="detail-panel" style={{ maxWidth: "500px" }}>
        <div className="detail-panel-header">
          <h2>{id ? "Edit Dragon" : "Add Dragon"}</h2>
          <button className="detail-panel-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Dragon ID
            </label>
            <input
              type="text"
              value={dragonId}
              onChange={(e) => setDragonId(e.target.value)}
              placeholder="kiro-A"
              disabled={!!id}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                background: id ? "var(--bg-secondary)" : "var(--bg-primary)",
              }}
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Smaug"
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
              }}
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Adapter
            </label>
            <select
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
              }}
            >
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Default Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
              }}
            >
              <option value="">-- Select model --</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Machine
            </label>
            <select
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
              }}
            >
              <option value="">-- Select machine --</option>
              {machines.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Standing Instructions
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Instructions specific to this dragon..."
              style={{
                width: "100%",
                minHeight: "80px",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                fontFamily: "monospace",
                fontSize: "0.85rem",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "0.5rem 1rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                background: "transparent",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!dragonId || !name}
              style={{
                padding: "0.5rem 1rem",
                borderRadius: "4px",
                border: "none",
                background: "var(--primary)",
                color: "white",
                cursor: "pointer",
              }}
            >
              {id ? "Update" : "Add"} Dragon
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// Model Dialog
interface ModelDialogProps {
  onSave: (model: AIModel) => void;
  onClose: () => void;
}

function ModelDialog({ onSave, onClose }: ModelDialogProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !name) return;
    onSave({ id, name, description });
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="detail-panel" style={{ maxWidth: "400px" }}>
        <div className="detail-panel-header">
          <h2>Add Model</h2>
          <button className="detail-panel-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Model ID
            </label>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="claude-sonnet-4-20250514"
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
              }}
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claude Sonnet 4"
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
              }}
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Fast and capable"
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={{ padding: "0.5rem 1rem", borderRadius: "4px", border: "1px solid var(--border)", background: "transparent", cursor: "pointer" }}>
              Cancel
            </button>
            <button type="submit" disabled={!id || !name} style={{ padding: "0.5rem 1rem", borderRadius: "4px", border: "none", background: "var(--primary)", color: "white", cursor: "pointer" }}>
              Add Model
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// Machine Dialog
interface MachineDialogProps {
  id: string;
  initial: MachineConfig;
  onSave: (id: string, config: MachineConfig) => void;
  onClose: () => void;
}

function MachineDialog({ id, initial, onSave, onClose }: MachineDialogProps) {
  const [name, setName] = useState(initial.name);
  const [host, setHost] = useState(initial.host || "");
  const [user, setUser] = useState(initial.user || "");
  const [keyPath, setKeyPath] = useState(initial.key || "");
  const [runners, setRunners] = useState(initial.runners?.join(", ") || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const config: MachineConfig = {
      ...initial,
      name,
      host: initial.type === "ssh" ? host : undefined,
      user: initial.type === "ssh" ? user : undefined,
      key: initial.type === "ssh" ? keyPath : undefined,
      runners: runners.split(",").map((r) => r.trim()).filter(Boolean) as ("heavy" | "light" | "remote")[],
    };
    onSave(id, config);
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="detail-panel" style={{ maxWidth: "450px" }}>
        <div className="detail-panel-header">
          <h2>Edit Machine: {id}</h2>
          <button className="detail-panel-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)" }}
            />
          </div>

          {initial.type === "ssh" && (
            <>
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
                  Host
                </label>
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="198.51.100.10"
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)" }}
                />
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
                  User
                </label>
                <input
                  type="text"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="deploy"
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)" }}
                />
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
                  SSH Key Path
                </label>
                <input
                  type="text"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/example_key"
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)" }}
                />
              </div>
            </>
          )}

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}>
              Runners (comma-separated)
            </label>
            <input
              type="text"
              value={runners}
              onChange={(e) => setRunners(e.target.value)}
              placeholder="heavy, light, remote"
              style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)" }}
            />
          </div>

          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={{ padding: "0.5rem 1rem", borderRadius: "4px", border: "1px solid var(--border)", background: "transparent", cursor: "pointer" }}>
              Cancel
            </button>
            <button type="submit" style={{ padding: "0.5rem 1rem", borderRadius: "4px", border: "none", background: "var(--primary)", color: "white", cursor: "pointer" }}>
              Save
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
