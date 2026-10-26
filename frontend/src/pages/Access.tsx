import { useCallback, useEffect, useState } from 'react';
import { api, type Catalog, type CatalogDoc, type LibraryDoc, when } from '../api';
import { Redacted } from '../ui';

// Stable bar widths per document, so a document always looks the same when redacted.
const BARS: Record<string, number[]> = {
  references: [2.6, 4.4, 6.1, 3, 5.2],
  offer_letter_2024: [3.2, 6.5, 2.4, 4.8, 3.6],
  salary_history: [5.5, 2.2, 7, 1.8, 4],
  tax_w2_2025: [22],
};

export function AccessPage({ onChange }: { onChange: () => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setCatalog(await api<Catalog>('/catalog'));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onChange]);

  useEffect(() => {
    load();
  }, [load]);

  const restricted = catalog?.documents.filter((d) => d.tag !== 'public') ?? [];
  const open = catalog?.documents.filter((d) => d.tag === 'public') ?? [];

  return (
    <main className="page">
      <header className="page-head">
        <h1>Documents</h1>
        <p>
          Everything the assistant can draw on, and what you can read today. Ask for a restricted document with a short
          reason; Aashish reviews each request, and an approval opens the document for a limited time.
        </p>
      </header>
      {error && <p className="error">{error}</p>}
      {!catalog && !error && <p className="muted">Loading documents…</p>}

      {catalog && (
        <>
          <section className="section" aria-labelledby="restricted">
            <h2 id="restricted">Restricted</h2>
            <p>Each of these has its own access tag. Without it, the search can't return a single line of them.</p>
            <ul className="ledger">
              {restricted.map((d) => (
                <RestrictedDoc key={d.doc_id} doc={d} onRequested={load} />
              ))}
            </ul>
          </section>

          <section className="section" aria-labelledby="open">
            <h2 id="open">Open to every recruiter</h2>
            <ul className="ledger">
              {open.map((d) => (
                <li key={d.doc_id}>
                  <div className="row">
                    <div>
                      <h3>{d.title}</h3>
                      <p>{d.description}</p>
                    </div>
                    <span className="status open">You can read this</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="section" aria-labelledby="library">
            <h2 id="library">Design records</h2>
            <p>
              READMEs, architecture notes and decision records (ADRs) from his public GitHub projects. Ask the assistant
              why something was built the way it was, and it answers from these.
            </p>
            <Library docs={catalog.library ?? []} />
          </section>
        </>
      )}
    </main>
  );
}

function RestrictedDoc({ doc, onRequested }: { doc: CatalogDoc; onRequested: () => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = doc.request?.status === 'pending';

  let status: { text: string; tone: string };
  if (doc.has_access)
    status = {
      text: doc.request?.expires_at ? `Open until ${when(doc.request.expires_at)}` : 'You can read this',
      tone: 'open',
    };
  else if (pending) status = { text: 'Request pending', tone: 'waiting' };
  else if (!doc.requestable) status = { text: 'Never shared', tone: 'never' };
  else if (doc.request?.status === 'denied') status = { text: 'Request denied', tone: 'sealed' };
  else if (doc.request?.status === 'approved') status = { text: 'Access expired', tone: 'sealed' };
  else status = { text: 'On request', tone: 'sealed' };

  const canAsk = doc.requestable && !doc.has_access && !pending;

  return (
    <li className={doc.requestable ? '' : 'never'}>
      <div className="row">
        <div>
          <h3>{doc.title}</h3>
          <p>{doc.description}</p>
          {!doc.has_access && <Redacted widths={BARS[doc.doc_id] ?? [4, 6, 3]} label="Contents hidden" />}
        </div>
        <span className={`status ${status.tone}`}>{status.text}</span>
      </div>
      {canAsk && !asking && (
        <p style={{ marginTop: '0.75rem' }}>
          <button className="quiet" onClick={() => setAsking(true)}>
            Request access
          </button>
        </p>
      )}
      {canAsk && asking && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/requests', { method: 'POST', body: { tag: doc.tag, reason } });
              setReason('');
              setAsking(false);
              onRequested();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Why do you need it?
            <textarea
              required
              autoFocus
              maxLength={500}
              rows={2}
              placeholder="For example: preparing an offer for a senior role"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button disabled={busy || !reason.trim()}>Send request</button>
            <button type="button" className="quiet" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </li>
  );
}

function Library({ docs }: { docs: LibraryDoc[] }) {
  const projects = new Map<string, LibraryDoc[]>();
  for (const d of docs) projects.set(d.project, [...(projects.get(d.project) ?? []), d]);
  if (projects.size === 0) return <p className="muted">No design records are loaded.</p>;
  return (
    <div className="library">
      {[...projects].map(([project, items]) => (
        <div key={project}>
          <h3>{project}</h3>
          <ul>
            {items.map((d) => (
              <li key={d.source}>
                <a href={d.source} target="_blank" rel="noreferrer">
                  {d.title.slice(project.length).replace(/^:\s*|^\s+/, '')}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
