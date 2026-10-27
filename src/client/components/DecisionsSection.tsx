/**
 * Decisions: the Decision Inbox (every project's decisions; a row opens
 * #/decisions/<id>) and, on its own tab, the owner's message file (inbox_file:
 * instructions to the orchestrator and its replies; the old "Owner messages"
 * view). This is also where a browser signs in as the owner.
 */
import { useEffect, useState } from "react";
import type { Decision } from "../../shared/decision-types";
import { decisionSummary, listDecisions, type DecisionSummary } from "../decisions-api";
import { ownerStatus, signIn } from "../owner-session";
import { DecisionInboxView } from "./DecisionInbox";
import { Inbox } from "./Inbox";
import { SectionHeader, type SectionProps } from "./Section";
import { ErrorState, Loading } from "./ui";

export function DecisionsSection({ project, refreshKey, route, modules, open }: SectionProps) {
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [summary, setSummary] = useState<DecisionSummary | null>(null);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const onMessages = route.tab === "messages";

  useEffect(() => {
    if (onMessages) return;
    let cancelled = false;
    Promise.all([listDecisions(), decisionSummary(), ownerStatus()])
      .then(([list, counts, session]) => {
        if (cancelled) return;
        setDecisions(list);
        setSummary(counts);
        setAnswering(session.signedIn);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, reload, onMessages]);

  const body = () => {
    if (onMessages) return <Inbox project={project} refreshKey={refreshKey} />;
    if (!decisions && error) return <ErrorState what="the decisions" error={error} />;
    if (!decisions) return <Loading what="decisions" />;
    return (
      <>
        {error && <ErrorState what="the latest decisions" error={error} />}
        <DecisionInboxView
          decisions={decisions}
          secretStore={summary?.secretStore ?? "the server's secret store"}
          now={Date.now()}
          answering={answering}
          onUnlock={async (token) => {
            await signIn(token);
            setReload((n) => n + 1);
          }}
          onSignedOut={() => setReload((n) => n + 1)}
          onAnswered={() => setReload((n) => n + 1)}
          selected={route.detail}
          onOpen={open}
        />
      </>
    );
  };

  return (
    <div>
      <SectionHeader title="Decisions" section="decisions" route={route} modules={modules} />
      {body()}
    </div>
  );
}
