import { getCurrentUser, signOut } from 'aws-amplify/auth';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, type Me } from './api';
import { AuthPanel } from './pages/Auth';
import { AccessPage } from './pages/Access';
import { AdminPage } from './pages/Admin';
import { ChatPage } from './pages/Chat';

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

  if (!signedIn) {
    return (
      <main className="landing">
        <section className="pitch">
          <p className="eyebrow">Sentinel demo</p>
          <h1>Ask about Aashish's resume.</h1>
          <p>
            Sign up as a recruiter and chat with an assistant that answers from Aashish's documents. You can read the
            resume and project notes. The offer letter, salary history and references are restricted, and the tax form
            is never shared.
          </p>
          <p>
            The restriction is enforced <em>before</em> the model sees anything: your permissions become a filter in the
            vector search, and every result is checked again. If you need a restricted document, request it, and it
            opens for you on your next question once approved.
          </p>
          <a className="source" href="https://github.com/aashishravindran/sentinel-resume">
            Source on GitHub
          </a>
        </section>
        <AuthPanel onSignedIn={() => setSignedIn(true)} />
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">Resume Assistant</span>
        <nav>
          <NavLink to="/chat">Chat</NavLink>
          <NavLink to="/access">Request access</NavLink>
          {me?.is_admin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <span className="who">{me?.email}</span>
        <button
          className="link"
          onClick={async () => {
            await signOut();
            setSignedIn(false);
            setMe(null);
          }}
        >
          Sign out
        </button>
      </header>
      <Routes>
        <Route path="/chat" element={<ChatPage me={me} />} />
        <Route path="/access" element={<AccessPage onChange={refreshMe} />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </div>
  );
}
