/**
 * Command Bar - Always-visible input for Ask / Instruct / Message / Task
 *
 * Phase 3: "Instruct" and "Message" now send through the bus with delivery state tracking.
 *
 * Ask: with the supervisor's chat on (supervisor.chat.enabled), a question
 * opens the chat panel and is answered by a supervisor run
 * (SupervisorChat.tsx); otherwise it goes to the orchestrator's ask command
 * as before. "@<dragon-id> ..." is a message to that dragon either way.
 */
import { useState, useCallback } from "react";
import type { CommandMode, CommandResult } from "../../shared/types";
import type { MessageDeliveryState } from "../../shared/bus-types";
import { runCommand, sendBusMessage } from "../owner-actions";
import { SignInHint } from "./SignInHint";
import { Button } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";

interface Props {
  project: string;
  mode: CommandMode;
  onModeChange: (mode: CommandMode) => void;
  readOnly: boolean;
  prefill?: string;
  onPrefillUsed?: () => void;
  /** Ask the supervisor instead of the orchestrator (supervisor.chat is on and can answer) */
  onAskSupervisor?: (question: string) => void;
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
  onAskSupervisor,
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
          const data = await sendBusMessage(project, "orchestrator", text.trim());
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
          // Bus inboxes match the agent ID exactly, so send it as typed
          const data = await sendBusMessage(project, dragonId, message.trim());
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

        // A question for the supervisor: the chat panel asks it and shows the answer
        if (mode === "ask" && onAskSupervisor) {
          onAskSupervisor(text.trim());
          setText("");
          setShowResult(false);
          return;
        }

        // Legacy command handling: ask the orchestrator, or run a task
        const data =
          mode === "task"
            ? await runCommand(project, "agent/run", { task: text.trim() })
            : await runCommand(project, "ask", { text: text.trim() });
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
    [text, mode, project, loading, readOnly, onAskSupervisor],
  );

  const modeLabels: Record<CommandMode, string> = {
    ask: "Ask",
    instruct: "Instruct",
    task: "Task",
  };

  const placeholders: Record<CommandMode, string> = {
    ask: onAskSupervisor
      ? "Ask Lair a question (its supervisor answers), or @<dragon-id> to message a dragon..."
      : "Ask a question, or @<dragon-id> to message a dragon...",
    instruct: "Send an instruction to the orchestrator via bus...",
    task: "Branch name to assign to a dragon...",
  };

  const isDisabled = loading || (mode !== "ask" && readOnly) || !text.trim();

  return (
    <div className="command-bar">
      <form onSubmit={handleSubmit} className="command-form">
        <div className="command-mode-selector" role="group" aria-label="Command type">
          {(["ask", "instruct", "task"] as CommandMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className="mode-button"
              aria-pressed={mode === m}
              onClick={() => onModeChange(m)}
              disabled={m !== "ask" && readOnly}
              title={m !== "ask" && readOnly ? "The project is read-only" : undefined}
            >
              {modeLabels[m]}
              {m !== "ask" && readOnly && <Icon name="lock" size={12} label="read-only" />}
            </button>
          ))}
        </div>

        <input
          type="text"
          className="input command-input"
          aria-label={`Command (${modeLabels[mode]})`}
          placeholder={placeholders[mode]}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={loading || (mode !== "ask" && readOnly)}
        />

        <Button type="submit" variant="primary" disabled={isDisabled}>
          {loading ? "..." : "Send"}
        </Button>
      </form>

      {/* Questions, instructions, messages and tasks all go out as the owner's */}
      <SignInHint what="Sending commands and messages" refreshKey={showResult ? 1 : 0} />

      {/* Result panel */}
      {showResult && result && (
        <div className="command-result">
          <div className="result-header">
            {result.type === "bus" ? (
              <BusResultHeader data={result.data} />
            ) : (
              <CommandResultHeader data={result.data} mode={mode} />
            )}
            <Button variant="ghost" size="sm" className="icon-button" aria-label="Close the result" onClick={() => setShowResult(false)}>
              <Icon name="close" size={14} />
            </Button>
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
    return (
      <span className="result-status failed">
        <Icon name="x-circle" />
        Failed
      </span>
    );
  }

  const stateDisplay = getDeliveryStateDisplay(data.state || "sent");

  return (
    <span className={`result-status success ${stateDisplay.className}`}>
      <Icon name={stateDisplay.icon} />
      Message {stateDisplay.label}
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
    <span className={`result-status ${data.success ? "success" : "failed"}`}>
      <Icon name={data.success ? "check-circle" : "x-circle"} />
      {mode === "ask" ? "Answer" : "Result"}
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
      <Icon name={display.icon} className="state-icon" />
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
  icon: IconName;
  label: string;
  className: string;
} {
  switch (state) {
    case "sent":
      return { icon: "arrow-up", label: "Sent", className: "state-sent" };
    case "read":
      return { icon: "eye", label: "Read", className: "state-read" };
    case "ack":
      return { icon: "check-circle", label: "Acknowledged", className: "state-ack" };
  }
}
