/**
 * Dragon stop dialog - confirmation before stopping a running dragon (the
 * kit's Dialog, as an alert dialog: Esc or Cancel keeps it running)
 */
import { useState } from "react";
import type { Dragon, DragonStopRequest } from "../../shared/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout, Card } from "../ui/Card";
import { Dialog } from "../ui/Dialog";
import { KeyValues } from "./ui";

interface Props {
  dragon: Dragon;
  onStop: (request: DragonStopRequest) => Promise<void>;
  onClose: () => void;
}

export function DragonStopDialog({ dragon, onStop, onClose }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStop = async () => {
    setError(null);
    setSubmitting(true);

    try {
      await onStop({ dragonId: dragon.id });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop dragon");
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title="Stop Dragon"
      role="alertdialog"
      onClose={onClose}
      closeOnScrim={!submitting}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleStop} disabled={submitting}>
            {submitting ? "Stopping..." : "Stop Dragon"}
          </Button>
        </>
      }
    >
      {/* Warning box */}
      <Callout tone="warning" title="Warning">
        <span className="muted">
          Stopping a dragon will interrupt its current work. The dragon will create a STOP file and terminate gracefully.
          Any uncommitted changes may be lost.
        </span>
      </Callout>

      {/* Dragon info */}
      <Card title="Dragon Details">
        <KeyValues
          rows={[
            ["ID:", <code key="id">{dragon.id}</code>],
            ["Name:", dragon.name],
            [
              "Status:",
              <Badge key="status" tone={dragon.running ? "success" : "neutral"}>
                {dragon.running ? "Running" : "Idle"}
              </Badge>,
            ],
            ["Current Task:", dragon.task || null],
          ]}
        />
      </Card>

      {/* Error display */}
      {error && (
        <Callout tone="danger" alert>
          {error}
        </Callout>
      )}
    </Dialog>
  );
}
