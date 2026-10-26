/**
 * Command Bar - Always-visible input for Ask / Instruct / Message / Task
 *
 * Phase 3: "Instruct" and "Message" now send through the bus with delivery state tracking.
 */
import { useState, useCallback } from "react";
import type { CommandMode, CommandResult } from "../../shared/types";
import type { MessageDeliveryState } from "../../shared/bus-types";

interface Props {
  project: string;
  mode: CommandMode;
  onModeChange: (mode: CommandMode) => void;
  readOnly: boolean;
  prefill?: string;
  onPrefillUsed?: () => void;
}

// Extended result for bus messages
interface BusMessageResult {
  success: boolean;
  id?: string;
  timestamp?: string;
  to?: string;
  text?: string;
  state?: MessageDeliveryState;
  error?: string;
}

// Combined result type
type ResultType =
  | { type: "command"; data: CommandResult }
  | { type: "bus"; data: BusMessageResult };

export function CommandBar({
  project,
  mode,
  onModeChange,
  readOnly,
  prefill,
  onPrefillUsed,
}: Props) {
  const [text, setText] = useState(prefill || "");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ResultType | null>(null);
  const [showResult, setShowResult] = useState(false);

  // Handle prefill changes
  if (prefill && prefill !== text && onPrefillUsed) {
    setText(prefill);
    onPrefillUsed();
  }

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!text.trim() || loading) return;

      setLoading(true);
      setResult(null);

      try {
        // Handle different modes
        if (mode === "instruct") {
          // Send through bus to orchestrator
          const res = await fetch(`/api/bus/send?project=${project}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to: "orchestrator",
              text: text.trim(),
            }),
          });

          const data = await res.json();
          if (data.success && data.data) {
            setResult({ type: "bus", data: data.data });
            setShowResult(true);
            setText(""); // Clear on success
          } else {
            setResult({
              type: "bus",
              data: { success: false, error: data.error || "Unknown error" },
            });
            setShowResult(true);
          }
          return;
        }

        // For "ask" mode, check if it looks like a dragon message
        // Format: "@<dragon-id> message" (any dragon ID), or
        // "tell <dragon-id> message" where the ID contains a "-" (kiro-A,
        // aider-1), so "tell the orchestrator ..." stays a question
        const dragonPattern =
          /^(?:@([A-Za-z](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?)|tell\s+([A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9_-]+))\s+(.+)/i;
        const match = text.match(dragonPattern);

        if (match && !readOnly) {
          const dragonId = match[1] ?? match[2];
          const message = match[3];
          const res = await fetch(`/api/bus/send?project=${project}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // Bus inboxes match the agent ID exactly, so send it as typed
              to: dragonId,
              text: message.trim(),
            }),
          });

          const data = await res.json();
          if (data.success && data.data) {
            setResult({ type: "bus", data: data.data });
            setShowResult(true);
            setText("");
          } else {
            setResult({
              type: "bus",
              data: { success: false, error: data.error || "Unknown error" },
            });
            setShowResult(true);
          }
          return;
        }

        // Legacy command handling
        let endpoint = "";
        let body: Record<string, unknown> = { text: text.trim() };

        switch (mode) {
          case "ask":
            endpoint = "/api/controls/ask";
            break;
          case "task":
            endpoint = "/api/controls/agent/run";
            body = { task: text.trim() };
            break;
        }

        const res = await fetch(`${endpoint}?project=${project}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json();
        if (data.success && data.data) {
          setResult({ type: "command", data: data.data });
          setShowResult(true);
          if (mode !== "ask") {
            setText(""); // Clear input on success for non-ask modes
          }
        } else {
          setResult({
            type: "command",
            data: {
              success: false,
              exitCode: -1,
              stdout: "",
              stderr: data.error || "Unknown error",
              command: [],
              timestamp: new Date().toISOString(),
            },
          });
          setShowResult(true);
        }
      } catch (err) {
        setResult({
          type: "command",
          data: {
            success: false,
            exitCode: -1,
            stdout: "",
            stderr: err instanceof Error ? err.message : "Network error",
            command: [],
            timestamp: new Date().toISOString(),
          },
        });
        setShowResult(true);
      } finally {
        setLoading(false);
      }
    },
    [text, mode, project, loading, readOnly],
  );

  const modeLabels: Record<CommandMode, string> = {
    ask: "Ask",
    instruct: "Instruct",
    task: "Task",
  };

  const placeholders: Record<CommandMode, string> = {
    ask: "Ask a question, or @<dragon-id> to message a dragon...",
    instruct: "Send an instruction to the orchestrator via bus...",
    task: "Branch name to assign to a dragon...",
  };

  const isDisabled = loading || (mode !== "ask" && readOnly) || !text.trim();

  return (
    <div className="command-bar">
      <form onSubmit={handleSubmit} className="command-form">
        <div className="command-mode-selector">
          {(["ask", "instruct", "task"] as CommandMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`mode-button ${mode === m ? "active" : ""} ${m !== "ask" && readOnly ? "disabled" : ""}`}
              onClick={() => onModeChange(m)}
              disabled={m !== "ask" && readOnly}
            >
              {modeLabels[m]}
              {m !== "ask" && readOnly && " 🔒"}
            </button>
          ))}
        </div>

        <input
          type="text"
          className="command-input"
          placeholder={placeholders[mode]}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={loading || (mode !== "ask" && readOnly)}
        />

        <button type="submit" className="command-submit" disabled={isDisabled}>
          {loading ? "..." : "Send"}
        </button>
      </form>

      {/* Result panel */}
      {showResult && result && (
        <div className="command-result">
          <div className="result-header">
            {result.type === "bus" ? (
              <BusResultHeader data={result.data} />
            ) : (
              <CommandResultHeader data={result.data} mode={mode} />
            )}
            <button
              className="result-close"
              onClick={() => setShowResult(false)}
            >
              ×
            </button>
          </div>
          <div className="result-content">
            {result.type === "bus" ? (
              <BusResultContent data={result.data} />
            ) : (
              <CommandResultContent data={result.data} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Bus result header
 */
function BusResultHeader({ data }: { data: BusMessageResult }) {
  if (!data.success) {
    return <span className="error">✗ Failed</span>;
  }

  const stateDisplay = getDeliveryStateDisplay(data.state || "sent");

  return (
    <span className={`success ${stateDisplay.className}`}>
      {stateDisplay.icon} Message {stateDisplay.label}
    </span>
  );
}

/**
 * Bus result content
 */
function BusResultContent({ data }: { data: BusMessageResult }) {
  if (!data.success) {
    return <pre className="stderr">{data.error}</pre>;
  }

  return (
    <div className="bus-result">
      <div className="bus-result-row">
        <span className="label">To:</span>
        <span className="value">{data.to}</span>
      </div>
      <div className="bus-result-row">
        <span className="label">ID:</span>
        <code className="value">{data.id}</code>
      </div>
      <div className="bus-result-row">
        <span className="label">State:</span>
        <DeliveryStateIndicator state={data.state || "sent"} />
      </div>
    </div>
  );
}

/**
 * Command result header (legacy)
 */
function CommandResultHeader({
  data,
  mode,
}: {
  data: CommandResult;
  mode: CommandMode;
}) {
  return (
    <span className={data.success ? "success" : "error"}>
      {data.success ? "✓" : "✗"} {mode === "ask" ? "Answer" : "Result"}
    </span>
  );
}

/**
 * Command result content (legacy)
 */
function CommandResultContent({ data }: { data: CommandResult }) {
  return (
    <>
      {data.stdout && <pre>{data.stdout}</pre>}
      {data.stderr && <pre className="stderr">{data.stderr}</pre>}
    </>
  );
}

/**
 * Delivery state indicator with animation
 */
function DeliveryStateIndicator({ state }: { state: MessageDeliveryState }) {
  const display = getDeliveryStateDisplay(state);

  return (
    <span className={`delivery-state ${display.className}`}>
      <span className="state-icon">{display.icon}</span>
      <span className="state-label">{display.label}</span>
      {state === "sent" && (
        <span className="state-progress">Waiting for read...</span>
      )}
      {state === "read" && (
        <span className="state-progress">Waiting for ack...</span>
      )}
    </span>
  );
}

/**
 * Get delivery state display info
 */
function getDeliveryStateDisplay(state: MessageDeliveryState): {
  icon: string;
  label: string;
  className: string;
} {
  switch (state) {
    case "sent":
      return { icon: "📤", label: "Sent", className: "state-sent" };
    case "read":
      return { icon: "👁", label: "Read", className: "state-read" };
    case "ack":
      return { icon: "✓", label: "Acknowledged", className: "state-ack" };
  }
}
