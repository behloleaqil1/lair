/**
 * Asking Lair (src/server/supervisor/chat.ts): the chat panel the Ask tab
 * and Home's "Ask Lair" card open, and Home's latest digest.
 *
 * A question shows at once, then "Lair is looking…" while its supervisor run
 * reads Lair's tools (the conversation is read again every POLL_MS), then
 * the answer with the evidence it cites (collapsed), or "No answer" with
 * the reason. Answers are agent output: SafeMarkdown renders them without
 * HTML, with links only to the dashboard and the repository's host.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatStatusView, ConversationTurn, ConversationView, DigestView } from "../../shared/supervisor-types";
import type { LinkPolicy } from "../../shared/safe-markdown";
import { useApi } from "../hooks/useApi";
import {
  askSupervisor,
  chatHint,
  fetchConversation,
  hasPending,
  limitsLine,
  POLL_MS,
  turnStatus,
} from "../supervisor-chat";
import { SafeMarkdown } from "./SafeMarkdown";
import { Badge, ErrorState, OwnerOnlyNotice, Time, muted, useOwnerSignedIn } from "./ui";

/** Open the chat panel: on a conversation, and/or with a question to ask */
export interface ChatRequest {
  conversationId?: string | null;
  question?: string;
}

export const ChatContext = createContext<{ open: (request: ChatRequest) => void }>({ open: () => undefined });

/** The tool calls an answer cites, collapsed: each tool, its arguments and what it showed, as text. */
function EvidenceList({ turn }: { turn: ConversationTurn }) {
  if (turn.evidence.length === 0) return null;
  return (
    <details className="chat-evidence" data-evidence={turn.evidence.length}>
      <summary>{`Evidence (${turn.evidence.length})`}</summary>
      <ul className="plain-list">
        {turn.evidence.map((item, i) => (
          <li key={i}>
            <code>{item.tool}</code> <code style={muted}>{JSON.stringify(item.args)}</code>
            {item.note && <div>{item.note}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One question and what came of it. Stateless. */
export function TurnView({ turn, policy }: { turn: ConversationTurn; policy: LinkPolicy }) {
  const status = turnStatus(turn);
  return (
    <li className="chat-turn" data-turn={turn.state}>
      <div className="chat-question">
        <span style={muted}>
          You, <Time iso={turn.askedAt} />
        </span>
        <div style={{ whiteSpace: "pre-wrap" }}>{turn.question}</div>
      </div>
      <div className="chat-answer">
        {turn.state === "pending" && (
          <p className="chat-looking" style={muted} data-looking="true">
            {status.label}
          </p>
        )}
        {turn.state === "answered" && turn.answer !== null && (
          <>
            <SafeMarkdown text={turn.answer} policy={policy} />
            <EvidenceList turn={turn} />
            <p style={muted}>
              {turn.agent ? `${turn.agent}, ` : ""}
              {turn.answeredAt && <Time iso={turn.answeredAt} />}
            </p>
          </>
        )}
        {turn.state === "no_answer" && (
          <p data-no-answer="true">
            <Badge tone={status.tone}>{status.label}</Badge> <span style={muted}>{turn.reason}</span>
          </p>
        )}
      </div>
    </li>
  );
}

/** A conversation's questions and answers. Stateless. */
export function ConversationTurns({ conversation }: { conversation: ConversationView }) {
  const policy: LinkPolicy = { repoUrl: conversation.repoUrl };
  return (
    <ol className="chat-turns">
      {conversation.turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} policy={policy} />
      ))}
    </ol>
  );
}

/** The chat panel: the conversation, and a box for the next question. */
export function SupervisorChatPanel({
  project,
  request,
  onClose,
}: {
  project: string;
  /** What opened it; a new object opens again */
  request: ChatRequest;
  onClose: () => void;
}) {
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const ask = useCallback(
    async (question: string, conversationId: string | null) => {
      setSending(true);
      setError(null);
      try {
        const res = await askSupervisor(project, question, conversationId);
        if (!live.current) return;
        if (res.success && res.data) setConversation(res.data.conversation);
        else setError(res.error ?? "The question was refused");
      } catch (e) {
        if (live.current) setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (live.current) setSending(false);
      }
    },
    [project],
  );

  // Opened on a conversation, with a question, or both
  useEffect(() => {
    setError(null);
    if (request.conversationId) {
      fetchConversation(request.conversationId)
        .then((c) => {
          if (!live.current) return;
          setConversation(c);
          if (request.question) void ask(request.question, c.id);
        })
        .catch((e: unknown) => live.current && setError(e instanceof Error ? e.message : "Could not read the conversation"));
    } else {
      setConversation(null);
      if (request.question) void ask(request.question, null);
    }
  }, [request, ask]);

  // While a question waits for its answer, read the conversation again
  const pending = hasPending(conversation);
  const id = conversation?.id ?? null;
  useEffect(() => {
    if (!pending || !id) return;
    const timer = setTimeout(() => {
      fetchConversation(id)
        .then((c) => live.current && setConversation(c))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, id, conversation]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const question = text.trim();
    if (!question || sending || pending) return;
    setText("");
    void ask(question, conversation?.id ?? null);
  };

  return (
    <aside className="chat-panel card" aria-label="Ask Lair" data-panel="chat">
      <div className="chat-header">
        <h3>Ask Lair</h3>
        <span>
          {conversation && (
            <button type="button" className="small-button" onClick={() => setConversation(null)} disabled={sending}>
              New conversation
            </button>
          )}{" "}
          <button type="button" className="result-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </span>
      </div>
      {conversation ? (
        <ConversationTurns conversation={conversation} />
      ) : (
        <p style={muted}>
          Ask about this project and the fleet: why an agent is held, why nothing merges, which gates failed and why. Lair's
          supervisor answers from Lair's own records and cites them; it changes nothing.
        </p>
      )}
      {sending && !conversation && <p style={muted}>Asking…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="chat-form">
        <textarea
          className="chat-input"
          rows={2}
          maxLength={2000}
          placeholder={conversation ? "Ask a follow-up question…" : "Ask Lair a question…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={sending || pending}
        />
        <button type="submit" className="small-button primary" disabled={sending || pending || !text.trim()}>
          {sending ? "Asking…" : "Ask"}
        </button>
      </form>
    </aside>
  );
}

/** Home's "Ask Lair" card, from the chat's status (its own state: the text being typed). */
export function AskLairCardView({
  status,
  onAsk,
  onOpen,
}: {
  status: ChatStatusView;
  onAsk: (question: string) => void;
  onOpen: (conversationId: string) => void;
}) {
  const [text, setText] = useState("");
  const hint = chatHint(status);
  return (
    <div className="card" data-card="ask-lair">
      <h3>Ask Lair</h3>
      {hint ? (
        <p style={muted} data-hint="chat">
          {hint}
        </p>
      ) : (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onAsk(text.trim());
            setText("");
          }}
        >
          <input
            type="text"
            className="chat-input"
            maxLength={2000}
            placeholder="Why is an agent held? Why is nothing merging?"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="small-button primary" disabled={!text.trim()}>
            Ask
          </button>
        </form>
      )}
      {status.conversations.length > 0 && (
        <ul className="plain-list" data-list="conversations">
          {status.conversations.slice(0, 5).map((c) => (
            <li key={c.id}>
              <button type="button" className="link-button" onClick={() => onOpen(c.id)}>
                {c.title || "(a question)"}
              </button>{" "}
              <span style={muted}>
                {c.state === "pending" ? "looking…" : c.state === "no_answer" ? "no answer" : `${c.turns} question(s)`},{" "}
                <Time iso={c.updatedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {!hint && <p style={muted}>{limitsLine(status)}</p>}
    </div>
  );
}

export function AskLairCard({ project, refreshKey }: { project: string; refreshKey: number }) {
  const chat = useContext(ChatContext);
  const signedIn = useOwnerSignedIn(refreshKey);
  const status = useApi<ChatStatusView>("/supervisor/chat", project, refreshKey, { owner: true, skip: signedIn !== true });
  if (signedIn === false) {
    return (
      <div className="card" data-card="ask-lair">
        <h3>Ask Lair</h3>
        <OwnerOnlyNotice text="Questions to Lair's supervisor are the owner's." />
      </div>
    );
  }
  if (!status.data) return status.error ? <ErrorState what="the supervisor's chat" error={status.error} /> : null;
  return (
    <AskLairCardView
      status={status.data}
      onAsk={(question) => chat.open({ question })}
      onOpen={(conversationId) => chat.open({ conversationId })}
    />
  );
}

/** Home's latest digest. Stateless; nothing when the digest is off and there is none. */
export function DigestCardView({ view }: { view: DigestView }) {
  if (!view.enabled && !view.latest) return null;
  const turn = view.latest?.turns[0] ?? null;
  return (
    <div className="card" data-card="digest">
      <h3>{`Today's digest${view.latest?.digestDate ? ` (${view.latest.digestDate})` : ""}`}</h3>
      {!turn ? (
        <p style={muted}>{`No digest yet: the supervisor writes one every day at ${view.time} (this machine's local time).`}</p>
      ) : (
        <ConversationAnswer turn={turn} policy={{ repoUrl: view.latest?.repoUrl ?? null }} />
      )}
    </div>
  );
}

/** A digest's answer, without the request Lair made. */
function ConversationAnswer({ turn, policy }: { turn: ConversationTurn; policy: LinkPolicy }) {
  if (turn.state === "pending") return <p style={muted}>Lair is writing today's digest…</p>;
  if (turn.state === "no_answer") {
    return (
      <p>
        <Badge tone="warning">No digest</Badge> <span style={muted}>{turn.reason}</span>
      </p>
    );
  }
  return (
    <>
      <SafeMarkdown text={turn.answer ?? ""} policy={policy} />
      <EvidenceList turn={turn} />
    </>
  );
}

export function DigestCard({ project, refreshKey }: { project: string; refreshKey: number }) {
  const signedIn = useOwnerSignedIn(refreshKey);
  const digest = useApi<DigestView>("/supervisor/digest", project, refreshKey, { owner: true, skip: signedIn !== true });
  if (!digest.data) return null;
  return <DigestCardView view={digest.data} />;
}
