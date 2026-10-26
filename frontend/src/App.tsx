import { getCurrentUser, signOut } from 'aws-amplify/auth';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import { api, type Me } from './api';
import { AccessPage } from './pages/Access';
import { AdminPage } from './pages/Admin';
import { AuthPanel } from './pages/Auth';
import { ChatPage } from './pages/Chat';
import { Brand, Redacted } from './ui';

const SOURCE_URL = 'https://github.com/aashishravindran/sentinel-resume';

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    getCurrentUser()
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, []);

  useEffect(() => {
    if (signedIn) refreshMe();
  }, [signedIn, refreshMe]);

  if (signedIn === null) return null;
  if (!signedIn) return <Landing onSignedIn={() => setSignedIn(true)} />;

  return (
    <>
      <header className="top">
        <Brand />
        <nav aria-label="Main">
          <NavLink to="/chat">Chat</NavLink>
          <NavLink to="/access">Documents</NavLink>
          {(me?.is_admin || me?.admin_needs_mfa) && (
            <NavLink to="/admin">
              Admin
              {me.pending_requests > 0 && (
                <span className="count-badge" aria-label={`${me.pending_requests} waiting`}>
                  {me.pending_requests}
                </span>
              )}
            </NavLink>
          )}
        </nav>
        <div className="account">
          <span>{me?.email}</span>
          <button
            className="quiet"
            onClick={async () => {
              await signOut();
              setSignedIn(false);
              setMe(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <Routes>
        <Route path="/chat" element={<ChatPage me={me} />} />
        <Route path="/access" element={<AccessPage onChange={refreshMe} />} />
        <Route path="/admin" element={<AdminPage onChange={refreshMe} />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </>
  );
}

type Shelf = { name: string; status: 'open' | 'sealed' | 'never'; preview?: string; bars?: number[] };

const SHELF: Shelf[] = [
  { name: 'Resume', status: 'open', preview: 'SDE II at Amazon Web Services' },
  { name: 'Projects', status: 'open', preview: 'Sentinel, VISION, ProductionRAG' },
  { name: 'Design records', status: 'open', preview: 'ADRs and flows from GitHub' },
  { name: 'Offer letter (2024)', status: 'sealed', bars: [3.2, 6.5, 2.4, 4.8] },
  { name: 'Salary history', status: 'sealed', bars: [5.5, 2.2, 7, 1.8] },
  { name: 'References', status: 'sealed', bars: [2.6, 4.4, 6.1, 3] },
  { name: 'W-2 (2025)', status: 'never', bars: [16.5] },
];

const STATUS_TEXT = { open: 'Every recruiter', sealed: 'On request', never: 'Never shared' };

function Landing({ onSignedIn }: { onSignedIn: () => void }) {
  return (
    <main className="landing">
      <div className="landing-top">
        <Brand />
        <a href={SOURCE_URL}>Source on GitHub</a>
      </div>
      <div className="landing-grid">
        <section className="pitch">
          <h1>Ask anything about Aashish's work.</h1>
          <p className="lede">
            An assistant that answers from his resume, projects and design records, using only the documents you're
            allowed to read. Your access becomes a filter inside the search, so restricted text never reaches the model.
          </p>
          <ul className="shelf" aria-label="Documents and who can read them">
            {SHELF.map((d) => (
              <li key={d.name} className={d.status}>
                <span className="name">{d.name}</span>
                {d.bars ? (
                  <Redacted widths={d.bars} label={`${d.name}: contents hidden`} />
                ) : (
                  <span className="preview">{d.preview}</span>
                )}
                <span className={`status ${d.status}`}>{STATUS_TEXT[d.status]}</span>
              </li>
            ))}
          </ul>
          <p className="shelf-caption">
            Request a restricted document after you sign up. Aashish reviews each request, and an approval opens the
            document for a limited time. The restricted documents are synthetic; the resume and projects are real.
          </p>
        </section>
        <AuthPanel onSignedIn={onSignedIn} />
      </div>
    </main>
  );
}
