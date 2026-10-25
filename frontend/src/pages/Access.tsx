import { useCallback, useEffect, useState } from 'react';
import { api, type CatalogDoc, when } from '../api';

export function AccessPage({ onChange }: { onChange: () => void }) {
  const [docs, setDocs] = useState<CatalogDoc[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setDocs((await api<{ documents: CatalogDoc[] }>('/catalog')).documents);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onChange]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="page">
      <h1>Documents</h1>
      <p className="muted">
        Everything the assistant can draw on. Ask for a restricted document with a short reason. Aashish reviews each
        request, and an approval opens the document for a limited time.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="docs">
        {docs.map((d) => (
          <DocCard key={d.doc_id} doc={d} onRequested={load} />
        ))}
      </div>
    </main>
  );
}

function DocCard({ doc, onRequested }: { doc: CatalogDoc; onRequested: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = doc.request?.status === 'pending';

  let status: string;
  if (doc.has_access) {
    status = doc.request?.expires_at ? `Access until ${when(doc.request.expires_at)}` : 'You can read this';
  } else if (pending) status = 'Request pending';
  else if (!doc.requestable) status = 'Never shared';
  else if (doc.request?.status === 'denied') status = 'Request denied';
  else if (doc.request?.status === 'approved') status = 'Access expired';
  else status = 'Restricted';

  return (
    <article className={`card doc ${doc.has_access ? 'open' : ''}`}>
      <header>
        <h3>{doc.title}</h3>
        <span className="badge">{status}</span>
      </header>
      <p>{doc.description}</p>
      {doc.requestable && !doc.has_access && !pending && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/requests', { method: 'POST', body: { tag: doc.tag, reason } });
              setReason('');
              onRequested();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea
            required
            maxLength={500}
            rows={2}
            placeholder="Why do you need it? e.g. preparing an offer for a senior role"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button disabled={busy || !reason.trim()}>Request access</button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </article>
  );
}
