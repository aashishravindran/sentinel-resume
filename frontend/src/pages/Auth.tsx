import {
  confirmResetPassword,
  confirmSignIn,
  confirmSignUp,
  resendSignUpCode,
  resetPassword,
  signIn,
  signUp,
} from 'aws-amplify/auth';
import { type FormEvent, useState } from 'react';

type Mode = 'signIn' | 'signUp' | 'confirm' | 'totp' | 'forgot' | 'reset';

export function AuthPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>('signUp');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doSignIn = async () => {
    const { isSignedIn, nextStep } = await signIn({ username: email, password });
    if (isSignedIn) return onSignedIn();
    if (nextStep.signInStep === 'CONFIRM_SIGN_UP') {
      await resendSignUpCode({ username: email });
      return setMode('confirm');
    }
    if (nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') return setMode('totp');
    throw new Error(`Unsupported sign-in step: ${nextStep.signInStep}`);
  };

  return (
    <section className="panel auth">
      {mode === 'signUp' && (
        <form onSubmit={run(async () => {
          await signUp({ username: email, password, options: { userAttributes: { email } } });
          setMode('confirm');
        })}>
          <h2>Create a recruiter account</h2>
          <Email value={email} onChange={setEmail} />
          <Password value={password} onChange={setPassword} hint="At least 12 characters with upper, lower and a digit." />
          <button disabled={busy}>Sign up</button>
          <p className="switch">
            Already have an account? <button type="button" className="link" onClick={() => setMode('signIn')}>Sign in</button>
          </p>
        </form>
      )}
      {mode === 'signIn' && (
        <form onSubmit={run(doSignIn)}>
          <h2>Sign in</h2>
          <Email value={email} onChange={setEmail} />
          <Password value={password} onChange={setPassword} />
          <button disabled={busy}>Sign in</button>
          <p className="switch">
            <button type="button" className="link" onClick={() => setMode('forgot')}>Forgot password?</button>
          </p>
          <p className="switch">
            New here? <button type="button" className="link" onClick={() => setMode('signUp')}>Create an account</button>
          </p>
        </form>
      )}
      {mode === 'confirm' && (
        <form onSubmit={run(async () => {
          await confirmSignUp({ username: email, confirmationCode: code.trim() });
          setCode('');
          await doSignIn();
        })}>
          <h2>Check your email</h2>
          <p>We sent a verification code to {email}.</p>
          <Code value={code} onChange={setCode} />
          <button disabled={busy}>Verify</button>
        </form>
      )}
      {mode === 'totp' && (
        <form onSubmit={run(async () => {
          const { isSignedIn } = await confirmSignIn({ challengeResponse: code.trim() });
          if (isSignedIn) onSignedIn();
        })}>
          <h2>Authenticator code</h2>
          <Code value={code} onChange={setCode} />
          <button disabled={busy}>Continue</button>
        </form>
      )}
      {mode === 'forgot' && (
        <form onSubmit={run(async () => {
          await resetPassword({ username: email });
          setMode('reset');
        })}>
          <h2>Reset your password</h2>
          <Email value={email} onChange={setEmail} />
          <button disabled={busy}>Email me a code</button>
          <p className="switch">
            <button type="button" className="link" onClick={() => setMode('signIn')}>Back to sign in</button>
          </p>
        </form>
      )}
      {mode === 'reset' && (
        <form onSubmit={run(async () => {
          await confirmResetPassword({ username: email, confirmationCode: code.trim(), newPassword: password });
          setCode('');
          await doSignIn();
        })}>
          <h2>Choose a new password</h2>
          <p>If {email} has an account, we sent it a code.</p>
          <Code value={code} onChange={setCode} />
          <Password value={password} onChange={setPassword} hint="At least 12 characters with upper, lower and a digit." />
          <button disabled={busy}>Set password and sign in</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function Email({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label>
      Work email
      <input type="email" autoComplete="email" required value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Password({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <label>
      Password
      <input type="password" autoComplete="current-password" required minLength={12} value={value}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Code({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label>
      Code
      <input inputMode="numeric" autoComplete="one-time-code" required value={value}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
