import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, type Catalog, type ChatReply, type Me, type Trace } from '../api';
import { Markdown } from '../ui';

interface Turn {
  question: string;
  reply?: ChatReply;
  error?: string;
}

const PROMPTS: { group: string; questions: string[] }[] = [
  {
    group: 'Experience',
    questions: ['What has Aashish built with Amazon Bedrock?', 'Where did he study, and what?'],
  },
  {
    group: 'Projects',
    questions: ['What is Sentinel, and what problem does it solve?', 'How does VISION split work across agents?'],
  },
  {
    group: 'Design decisions',
    questions: [
      'Why does Sentinel take identity from the transport, not a tool argument?',
      'Why does this assistant use S3 Vectors instead of OpenSearch?',
    ],
  },
  {
    group: 'Restricted documents',
    questions: ['What is his current salary?', 'What do his references say about him?'],
  },
];

export function ChatPage({ me }: { me: Me | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<Record<string, string>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const latest = [...turns].reverse().find((t) => t.reply)?.reply?.trace;

  useEffect(() => {
    // Design docs link to GitHub; the rest of the catalog has no public URL.
    api<Catalog>('/catalog')
      .then((c) => setSources(Object.fromEntries((c.library ?? []).map((d) => [d.title, d.source]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setQuestion('');
    setTurns((t) => [...t, { question: q.trim() }]);
    let update: Partial<Turn>;
    try {
      update = { reply: await api<ChatReply>('/chat', { method: 'POST', body: { question: q.trim() } }) };
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 429
          ? `You've reached the question limit. Try again in ${Math.ceil((err.retryAfter ?? 60) / 60)} minutes.`
          : err instanceof Error
            ? err.message
            : String(err);
      update = { error: message };
    }
    setTurns((t) => t.map((turn, i) => (i === t.length - 1 ? { ...turn, ...update } : turn)));
    setBusy(false);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(question);
    }
  };

  return (
    <main className="chat-layout">
      <section className="chat" aria-label="Conversation">
        {turns.length === 0 && (
          <div className="empty">
            <h1>What would you like to know?</h1>
            <p>
              Ask about his experience, his projects, or why a project was designed the way it was. Answers cite the
              documents they come from.
            </p>
            <div className="prompts">
              {PROMPTS.map((g) => (
                <div key={g.group}>
                  <h2>{g.group}</h2>
                  <ul>
                    {g.questions.map((q) => (
                      <li key={q}>
                        <button className="prompt" onClick={() => ask(q)}>
                          {q}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}
        <ol className="turns">
          {turns.map((t, i) => (
            <li key={i} className="turn">
              <p className="q">{t.question}</p>
              {t.reply && <Reply reply={t.reply} sources={sources} />}
              {t.error && <p className="error">{t.error}</p>}
              {!t.reply && !t.error && (
                <div className="thinking" role="status" aria-label="Searching the documents you can read">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </li>
          ))}
        </ol>
        <div ref={bottom} />
        <form
          className="ask"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            ask(question);
          }}
        >
          <div className="ask-box">
            <textarea
              rows={Math.min(5, Math.max(1, question.split('\n').length))}
              value={question}
              maxLength={1000}
              placeholder="Ask about experience, projects or design decisions"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKey}
              aria-label="Your question"
            />
            <button disabled={busy || !question.trim()}>Ask</button>
          </div>
          <small>Enter to send, Shift+Enter for a new line.</small>
        </form>
      </section>
      <TracePanel trace={latest} me={me} />
    </main>
  );
}

function Reply({ reply, sources }: { reply: ChatReply; sources: Record<string, string> }) {
  if (reply.answered === false) {
    return (
      <div className="denied">
        <p>Nothing you can read answers that.</p>
        <p className="muted">
          The answer may be in a restricted document. <Link to="/access">Request access on the Documents page</Link>.
        </p>
      </div>
    );
  }
  return (
    <>
      <Markdown text={reply.answer} />
      {reply.citations.length > 0 && (
        <div className="sources">
          <span>Sources</span>
          {reply.citations.map((title) =>
            sources[title] ? (
              <a key={title} className="source" href={sources[title]} target="_blank" rel="noreferrer">
                {title}
              </a>
            ) : (
              <span key={title} className="source">
                {title}
              </span>
            ),
          )}
        </div>
      )}
    </>
  );
}

function TracePanel({ trace, me }: { trace?: Trace; me: Me | null }) {
  const scope = trace?.scope ?? me?.scope ?? [];
  return (
    <aside className="panel trace" aria-label="What the assistant saw">
      <h2>What the assistant saw</h2>
      <p>
        Your access is turned into a filter inside the vector search, and every result is checked again before the model
        sees it.
      </p>
      <ol className="steps">
        <li>
          <h3>Your access</h3>
          {scope.map((t) => (
            <code key={t} className="tag">
              {t}
            </code>
          ))}
        </li>
        <li>
          <h3>Filter in the search</h3>
          {trace ? (
            <pre>{JSON.stringify(trace.filter, null, 1)}</pre>
          ) : (
            <p className="muted">Ask a question to see it.</p>
          )}
        </li>
        <li>
          <h3>Retrieved</h3>
          {trace ? (
            <p>
              <span className="count">{trace.retrieved}</span> passages, all inside your access
            </p>
          ) : (
            <p className="muted">Waiting for a question.</p>
          )}
        </li>
        <li>
          <h3>Checked again</h3>
          {trace ? (
            <p>
              <span className={`count ${trace.dropped_by_postcheck ? 'drop' : ''}`}>{trace.dropped_by_postcheck}</span>{' '}
              removed by the re-check, <span className="count">{trace.below_relevance}</span> below the relevance cutoff
            </p>
          ) : (
            <p className="muted">Waiting for a question.</p>
          )}
        </li>
        <li>
          <h3>Sent to the model</h3>
          {!trace && <p className="muted">Waiting for a question.</p>}
          {trace && trace.chunks.length === 0 && <p>Nothing. The model wasn't called.</p>}
          {trace && trace.chunks.length > 0 && (
            <ul className="sent">
              {trace.chunks.map((c, i) => (
                <li key={i}>
                  <span>{c.title}</span>
                  <span className="score">{c.score.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ol>
      <Link to="/access">See every document and request access</Link>
    </aside>
  );
}
