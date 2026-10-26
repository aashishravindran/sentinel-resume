import { setUpTOTP, updateMFAPreference, verifyTOTPSetup } from 'aws-amplify/auth';
import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type AccessRequest, type AdminOverview, api, when } from '../api';

const DURATIONS = [
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
  { label: '30 days', minutes: 43200 },
];

export function AdminPage({ onChange }: { onChange: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await api<AdminOverview>('/admin/overview'));
      setForbidden(false);
      onChange();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [onChange]);

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
        <header className="page-head">
          <h1>Admin</h1>
          <p>
            Turn on an authenticator app to open the admin page. Only people listed in <code>infra/admins.json</code>{' '}
            get past this step; for anyone else the page stays closed.
          </p>
        </header>
        <MfaSetup onDone={load} />
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-head">
        <h1>Access requests</h1>
        <p>
          Approve a request to open one document to one recruiter for the time you choose. Revoking takes effect on
          their next question.
        </p>
      </header>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading requests…</p>}
      {data && (
        <>
          <section className="section" aria-labelledby="pending">
            <h2 id="pending">Waiting for you</h2>
            {data.pending.length === 0 && <p>No requests are waiting.</p>}
            <ul className="ledger">
              {data.pending.map((r) => (
                <PendingRow key={r.request_id} request={r} act={act} />
              ))}
            </ul>
          </section>

          <section className="section" aria-labelledby="grants">
            <h2 id="grants">Open grants</h2>
            {data.grants.length === 0 && <p>Nobody has extra access right now.</p>}
            {data.grants.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Recruiter</th>
                      <th>Document tag</th>
                      <th>Open until</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.grants.map((g) => (
                      <tr key={`${g.user_id}:${g.tag}`}>
                        <td>{g.email || g.user_id}</td>
                        <td>
                          <code className="tag">{g.tag}</code>
                        </td>
                        <td>{when(g.expires_at)}</td>
                        <td>
                          <button
                            className="danger"
                            onClick={() => act('/admin/grants/revoke', { user_id: g.user_id, tag: g.tag })}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="section" aria-labelledby="audit">
            <h2 id="audit">Today's audit log</h2>
            {data.audit.length === 0 && <p>Nothing has happened today.</p>}
            {data.audit.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>Who</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
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
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function PendingRow({ request, act }: { request: AccessRequest; act: (path: string, body: unknown) => Promise<void> }) {
  const [minutes, setMinutes] = useState(10080);
  const id = encodeURIComponent(request.request_id);
  return (
    <li className="request">
      <div>
        <h3>
          {request.email || request.user_id} wants <code className="tag">{request.tag}</code>
        </h3>
        <blockquote>{request.reason}</blockquote>
        <small>Requested {when(request.created_at)}</small>
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
    </li>
  );
}

function MfaSetup({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');

  return (
    <section className="panel mfa">
      <h2>Authenticator app</h2>
      {!secret && (
        <button
          onClick={async () => {
            const details = await setUpTOTP();
            const setupUri = details.getSetupUri('Sentinel Resume').toString();
            setSecret(details.sharedSecret);
            setUri(setupUri);
            // Drawn in the browser: the secret never leaves this page.
            setQr(await QRCode.toDataURL(setupUri, { margin: 1, width: 220, errorCorrectionLevel: 'M' }));
          }}
        >
          Set up an authenticator app
        </button>
      )}
      {secret && (
        <form
          className="mfa"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await verifyTOTPSetup({ code: code.trim() });
              await updateMFAPreference({ totp: 'PREFERRED' });
              setMessage('Authenticator turned on. Reloading the admin page.');
              onDone();
            } catch (err) {
              setMessage(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <ol className="mfa-steps">
            <li>
              Scan this code with an authenticator app (Google Authenticator, 1Password, Authy, Microsoft
              Authenticator).
              {qr && <img className="qr" src={qr} width={220} height={220} alt="QR code for your authenticator app" />}
            </li>
            <li>
              Can't scan? Enter this key by hand, or <a href={uri}>open it on this phone</a>:
              <code className="secret">{secret}</code>
            </li>
            <li>Type the 6-digit code the app shows.</li>
          </ol>
          <label>
            Code from the app
            <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <button>Turn on</button>
        </form>
      )}
      {message && <p>{message}</p>}
    </section>
  );
}
