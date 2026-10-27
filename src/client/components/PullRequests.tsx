/**
 * PRs: the open pull requests (the old PRs and Reviews views). With the
 * review module on (review.enabled), each row's readiness is the review
 * module's evaluation at the PR's head: "Merge ready" only when it allows
 * the merge, else the first reason; a PR not evaluated at its head yet is
 * evaluated from here, one at a time (pr-readiness.ts). Without it, the list
 * comes from the git host and only says whether the gate passed. A row opens
 * the PR's detail (#/prs/<n>).
 */
import { useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { prStatus } from "../review-api";
import { prsToCheck, type ReadinessCheck } from "../pr-readiness";
import { hostRows, prsToEvaluate, recheckAllQuestion, reviewRows, type PrRow } from "../pr-view";
import { TIER_BADGE, shortSha } from "../review-view";
import type { PullRequest } from "../../shared/types";
import type { PrSummary, ReviewProjectInfo } from "../../shared/review-types";
import { DataTable, type Column } from "./DataTable";
import { SectionHeader, type SectionProps } from "./Section";
import { PrDetail } from "./PrDetail";
import { EmptyState, ErrorState, Loading, Time, muted, useOwnerSignedIn } from "./ui";

/**
 * Evaluate, one at a time, the PRs of the review list not evaluated at their
 * head; and, each time `recheck` goes up ("Re-check all"), every open PR.
 */
function useReadinessChecks(project: string, prs: PrSummary[] | null, recheck: number): Record<number, ReadinessCheck> {
  const [checks, setChecks] = useState<Record<number, ReadinessCheck>>({});
  const checksRef = useRef<Record<number, ReadinessCheck>>({});
  const inFlight = useRef(new Set<number>());
  const projectRef = useRef(project);
  const forced = useRef(0);

  useEffect(() => {
    projectRef.current = project;
    checksRef.current = {};
    inFlight.current = new Set();
    setChecks({});
  }, [project]);

  useEffect(() => {
    if (!prs) return;
    const force = recheck > forced.current;
    forced.current = recheck;
    const due = prsToCheck(prsToEvaluate(prs, force), checksRef.current, Date.now(), { force, inFlight: inFlight.current });
    if (due.length === 0) return;
    const asked = project;
    const pending = inFlight.current;
    for (const pr of due) pending.add(pr.number);
    void (async () => {
      for (const pr of due) {
        let check: ReadinessCheck;
        try {
          const status = await prStatus(asked, pr.number);
          check = { headSha: pr.headRefOid, checkedAt: Date.now(), status, error: null };
        } catch (e) {
          check = {
            headSha: pr.headRefOid,
            checkedAt: Date.now(),
            status: null,
            error: e instanceof Error ? e.message : "the review module did not answer",
          };
        } finally {
          pending.delete(pr.number);
        }
        // The project changed while this was asked: the answer belongs to the old one
        if (projectRef.current !== asked) return;
        checksRef.current = { ...checksRef.current, [pr.number]: check };
        setChecks(checksRef.current);
      }
    })();
  }, [prs, project, recheck]);

  return checks;
}

export function PullRequests({ project, refreshKey, route, modules, readOnly, open }: SectionProps) {
  const reviewOn = modules?.review === true;
  const info = useApi<ReviewProjectInfo>("/review/status", project, refreshKey, { skip: !reviewOn });
  const summaries = useApi<PrSummary[]>("/review/prs", project, refreshKey, { skip: !reviewOn });
  const hostPrs = useApi<PullRequest[]>("/prs", project, refreshKey, { skip: reviewOn || modules === null });
  const signedIn = useOwnerSignedIn(refreshKey);
  const [recheck, setRecheck] = useState(0);
  const checks = useReadinessChecks(project, reviewOn ? summaries.data : null, recheck);

  const list = reviewOn ? summaries : hostPrs;
  const rows: PrRow[] = reviewOn ? reviewRows(summaries.data ?? [], checks) : hostRows(hostPrs.data ?? []);
  const ready = rows.filter((r) => r.readiness.group === "ready").length;

  const columns: Column<PrRow>[] = [
    { key: "number", label: "#", align: "right", sort: (r) => r.number, render: (r) => <span className="badge badge-neutral">#{r.number}</span> },
    { key: "title", label: "Title", sort: (r) => r.title, render: (r) => r.title },
    {
      key: "branch",
      label: "Branch",
      sort: (r) => r.branch,
      render: (r) => (
        <>
          <code>{r.branch}</code>
          <div style={muted}>{shortSha(r.headSha)}</div>
        </>
      ),
    },
    { key: "updated", label: "Updated", sort: (r) => r.updatedAt, render: (r) => <Time iso={r.updatedAt} /> },
    ...(reviewOn
      ? [
          {
            key: "tier",
            label: "Tier",
            sort: (r: PrRow) => (r.tier === "red" ? 0 : r.tier === "amber" ? 1 : r.tier === "green" ? 2 : null),
            render: (r: PrRow) => (r.tier ? <span className={`badge ${TIER_BADGE[r.tier]}`}>{r.tier}</span> : <span style={muted}>—</span>),
          },
        ]
      : []),
    {
      key: "ready",
      label: reviewOn ? "Merge" : "Gate",
      sort: (r) => (r.readiness.group === "ready" ? 0 : 1),
      render: (r) => (
        <span className={r.readiness.group === "ready" ? "badge badge-success" : undefined} style={r.readiness.group === "ready" ? undefined : muted}>
          {r.readiness.label}
        </span>
      ),
    },
  ];

  const body = () => {
    if (list.loading && !list.data) return <Loading what="pull requests" />;
    if (list.error && !list.data) {
      return (
        <ErrorState
          what="pull requests"
          error={list.error}
          hint={reviewOn ? "The review module reads them from the git host: check its token (review: in the YAML)." : "Lair lists them with the gh CLI: check that gh is installed and signed in."}
        />
      );
    }
    return (
      <div className="card">
        <DataTable
          label="Open pull requests"
          columns={columns}
          rows={rows}
          rowKey={(r) => String(r.number)}
          onOpen={(r) => open(String(r.number))}
          selected={route.detail}
          initialSort={{ key: "number", dir: "desc" }}
          empty={<EmptyState title="No open pull requests">They show here as soon as the git host lists them.</EmptyState>}
        />
      </div>
    );
  };

  const number = route.detail && /^[1-9]\d{0,9}$/.test(route.detail) ? Number(route.detail) : null;
  return (
    <div>
      <SectionHeader title="Pull requests" section="prs" route={route} modules={modules}>
        <span style={muted}>
          {rows.length} open, {ready} {reviewOn ? "ready to merge" : "with a passed gate"}
          {info.data?.repo ? ` · ${info.data.repo}` : ""}
        </span>
        {info.data?.readOnly && <span className="badge badge-neutral">read-only: no merges</span>}
        {reviewOn && (
          <RecheckAllButton
            count={rows.length}
            signedIn={signedIn}
            onConfirmed={() => setRecheck((n) => n + 1)}
            confirm={(question) => window.confirm(question)}
          />
        )}
      </SectionHeader>
      {info.data?.errors.map((e) => (
        <div key={e} className="error">
          {e}
        </div>
      ))}
      {body()}
      {route.detail && (
        <PrDetail
          number={number}
          raw={route.detail}
          project={project}
          refreshKey={refreshKey}
          reviewOn={reviewOn}
          readOnly={readOnly || info.data?.readOnly === true}
          hostPr={hostPrs.data?.find((p) => p.number === number) ?? null}
          onClose={() => open(null)}
        />
      )}
    </div>
  );
}

/**
 * "Re-check all": evaluate every open PR again at its head, after a
 * confirmation. The owner's (each evaluation asks the git host several
 * times): disabled until this browser is signed in as the owner.
 */
export function RecheckAllButton({
  count,
  signedIn,
  onConfirmed,
  confirm,
}: {
  count: number;
  signedIn: boolean | null;
  onConfirmed: () => void;
  confirm: (question: string) => boolean;
}) {
  const owner = signedIn === true;
  return (
    <button
      type="button"
      className="small-button"
      data-action="recheck-all"
      disabled={!owner || count === 0}
      title={owner ? "Evaluate every open PR again" : "Sign this browser in as the owner from Decisions first"}
      onClick={() => {
        if (owner && confirm(recheckAllQuestion(count))) onConfirmed();
      }}
    >
      Re-check all
    </button>
  );
}
