/**
 * LiveIndicator - shows connection status in the shell.
 *
 * Displays:
 * - "Live" when connected and receiving updates
 * - "Reconnecting..." when the connection is lost
 * - Hidden when polling (60s fallback works silently)
 */
import type { ConnectionStatus } from "../hooks/reconnect";
import { Icon } from "../ui/Icon";
import "./LiveIndicator.css";

export interface LiveIndicatorProps {
  status: ConnectionStatus;
  /** True when live updates are being received */
  live: boolean;
}

export function LiveIndicator({ status, live }: LiveIndicatorProps) {
  if (status === "connected" && live) {
    return (
      <span className="live-indicator live-indicator-connected" aria-label="Live updates active">
        <Icon name="dot" size={8} className="live-dot" />
        Live
      </span>
    );
  }

  if (status === "reconnecting") {
    return (
      <span className="live-indicator live-indicator-reconnecting" aria-label="Reconnecting">
        <Icon name="clock" size={12} className="live-spinner" />
        Reconnecting…
      </span>
    );
  }

  // Connecting or closed: don't show anything
  return null;
}
