import { setUpTOTP, updateMFAPreference, verifyTOTPSetup } from 'aws-amplify/auth';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type AccessRequest, type AdminOverview, api, when } from '../api';

const DURATIONS = [
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
  { label: '30 days', minutes: 43200 },
];

export function AdminPage() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await api<AdminOverview>('/admin/overview'));
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (path: string, body: unknown) => {
    try {
      await api(path, { method: 'POST', body });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    load();
  };

  if (forbidden) {
    return (
      <main className="page">
        <h1>Admin</h1>
        <p>
          This page is only for admins listed in <code>infra/admins.json</code>. Admins must also turn on an
          authenticator app.
        </p>
        <MfaSetup onDone={load} />
      </main>
    );
  }

  return (
    <main className="page">
      <h1>Access requests</h1>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          {data.pending.length === 0 && <p className="muted">No pending requests.</p>}
          {data.pending.map((r) => (
            <PendingRow key={r.request_id} request={r} act={act} />
          ))}

          <h2>Active grants</h2>
          {data.grants.length === 0 && <p className="muted">Nobody has extra access right now.</p>}
          <table>
            <tbody>
              {data.grants.map((g) => (
                <tr key={`${g.user_id}:${g.tag}`}>
                  <td>{g.email || g.user_id}</td>
                  <td>
                    <code className="tag">{g.tag}</code>
                  </td>
                  <td>until {when(g.expires_at)}</td>
                  <td>
                    <button className="danger" onClick={() => act('/admin/grants/revoke', { user_id: g.user_id, tag: g.tag })}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Today's audit log</h2>
          <table className="audit">
            <tbody>
              {data.audit.map((a, i) => (
                <tr key={i}>
                  <td>{when(a.at)}</td>
                  <td>{a.action}</td>
                  <td>{a.email || a.subject || a.actor}</td>
                  <td>{a.tag ?? a.check ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}

function PendingRow({ request, act }: { request: AccessRequest; act: (path: string, body: unknown) => Promise<void> }) {
  const [minutes, setMinutes] = useState(10080);
  const id = encodeURIComponent(request.request_id);
  return (
    <article className="card pending-row">
      <div>
        <strong>{request.email || request.user_id}</strong> wants <code className="tag">{request.tag}</code>
        <p>“{request.reason}”</p>
        <small className="muted">{when(request.created_at)}</small>
      </div>
      <div className="actions">
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Grant duration">
          {DURATIONS.map((d) => (
            <option key={d.minutes} value={d.minutes}>
              {d.label}
            </option>
          ))}
        </select>
        <button onClick={() => act(`/admin/requests/${id}/approve`, { minutes })}>Approve</button>
        <button className="danger" onClick={() => act(`/admin/requests/${id}/deny`, {})}>
          Deny
        </button>
      </div>
    </article>
  );
}

function MfaSetup({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');

  return (
    <section className="card">
      <h2>Authenticator app</h2>
      {!secret && (
        <button
          onClick={async () => {
            const details = await setUpTOTP();
            setSecret(details.sharedSecret);
            setUri(details.getSetupUri('Sentinel Resume').toString());
          }}
        >
          Set up an authenticator app
        </button>
      )}
      {secret && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await verifyTOTPSetup({ code: code.trim() });
              await updateMFAPreference({ totp: 'PREFERRED' });
              setMessage('Authenticator enabled.');
              onDone();
            } catch (err) {
              setMessage(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <p>
            Add this key to your authenticator app, or open the link on your phone:
            <br />
            <code className="secret">{secret}</code>
            <br />
            <a href={uri}>otpauth link</a>
          </p>
          <label>
            Code from the app
            <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <button>Verify</button>
        </form>
      )}
      {message && <p>{message}</p>}
    </section>
  );
}
