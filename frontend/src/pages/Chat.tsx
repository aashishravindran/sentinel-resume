import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, type ChatReply, type Me, type Trace } from '../api';

interface Turn {
  question: string;
  reply?: ChatReply;
  error?: string;
}

const SUGGESTIONS = [
  'What has Aashish built with Amazon Bedrock?',
  'Where did he study?',
  'What is his current salary?',
  'What did his references say about him?',
];

export function ChatPage({ me }: { me: Me | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = [...turns].reverse().find((t) => t.reply)?.reply?.trace;

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setQuestion('');
    setTurns((t) => [...t, { question: q }]);
    let update: Partial<Turn>;
    try {
      update = { reply: await api<ChatReply>('/chat', { method: 'POST', body: { question: q } }) };
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 429
          ? `You've hit the question limit. Try again in ${Math.ceil((err.retryAfter ?? 60) / 60)} minutes.`
          : err instanceof Error
            ? err.message
            : String(err);
      update = { error: message };
    }
    setTurns((t) => t.map((turn, i) => (i === t.length - 1 ? { ...turn, ...update } : turn)));
    setBusy(false);
  };

  return (
    <main className="chat-layout">
      <section className="chat">
        {turns.length === 0 && (
          <div className="empty">
            <h2>Ask anything about Aashish's experience.</h2>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <ol className="turns">
          {turns.map((t, i) => (
            <li key={i}>
              <p className="q">{t.question}</p>
              {t.reply && (
                <div className="a">
                  <p>{t.reply.answer}</p>
                  {t.reply.citations.length > 0 && (
                    <p className="cites">Sources: {t.reply.citations.join(', ')}</p>
                  )}
                  {t.reply.citations.length === 0 && (
                    <p className="cites">
                      Need a restricted document? <Link to="/access">Request access</Link>.
                    </p>
                  )}
                </div>
              )}
              {t.error && <p className="a error">{t.error}</p>}
              {!t.reply && !t.error && <p className="a pending">Thinking…</p>}
            </li>
          ))}
        </ol>
        <form
          className="ask"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            ask(question);
          }}
        >
          <input
            value={question}
            maxLength={1000}
            placeholder="Ask about experience, projects, skills…"
            onChange={(e) => setQuestion(e.target.value)}
            aria-label="Your question"
          />
          <button disabled={busy || !question.trim()}>Ask</button>
        </form>
      </section>
      <TracePanel trace={latest} me={me} />
    </main>
  );
}

function TracePanel({ trace, me }: { trace?: Trace; me: Me | null }) {
  return (
    <aside className="card trace">
      <h3>Why can't I see that?</h3>
      <p className="muted">
        Sentinel turns your permissions into the vector search filter, then checks every result again before the model
        sees it.
      </p>
      <dl>
        <dt>Your scope</dt>
        <dd>
          {(trace?.scope ?? me?.scope ?? []).map((t) => (
            <code key={t} className="tag">
              {t}
            </code>
          ))}
        </dd>
        {trace && (
          <>
            <dt>Filter in the vector query</dt>
            <dd>
              <pre>{JSON.stringify(trace.filter, null, 1)}</pre>
            </dd>
            <dt>Retrieved</dt>
            <dd>{trace.retrieved} chunks</dd>
            <dt>Removed by the re-check</dt>
            <dd>{trace.dropped_by_postcheck}</dd>
            <dt>Below relevance</dt>
            <dd>{trace.below_relevance}</dd>
            <dt>Sent to the model</dt>
            <dd>
              {trace.chunks.length === 0
                ? 'nothing'
                : trace.chunks.map((c, i) => (
                    <div key={i}>
                      {c.title} <span className="muted">({c.score.toFixed(2)})</span>
                    </div>
                  ))}
            </dd>
          </>
        )}
      </dl>
      <Link to="/access">Request access to more documents →</Link>
    </aside>
  );
}
