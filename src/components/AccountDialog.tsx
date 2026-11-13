import { useEffect, useState } from 'react';
import { closeDialog, Modal } from './Modal';
import { confirmDialog } from './Confirm';
import { useStore } from '../store/store';
import {
  createWorkspace,
  deleteAccount,
  deleteWorkspace,
  sendMagicLink,
  sendPasswordReset,
  signIn,
  signInWithProvider,
  signOut,
  signUp,
  switchWorkspace,
  syncNow,
  updateDisplayName,
  updatePassword,
  useCloud,
} from '../lib/cloud';
import { enabledProviders, type OAuthProvider } from '../lib/supabase';

function errText(e: unknown): string {
  const err = e as { message?: string; code?: string; status?: number };
  const code = err?.code ?? '';
  if (code === 'invalid_credentials') return 'Wrong email or password.';
  if (code === 'email_not_confirmed') return 'Please confirm your email first — check your inbox for the confirmation link.';
  if (code === 'user_already_exists') return 'An account with this email already exists. Sign in instead.';
  if (code === 'signup_disabled') return 'New sign-ups are closed. Ask the owner for an account.';
  if (code === 'over_email_send_rate_limit') return 'Too many emails were sent recently (the free plan allows only a few per hour). Try again later or use your password.';
  if (code === 'weak_password') return err.message ?? 'That password is too weak.';
  if (code === 'otp_disabled' || code === 'user_not_found') return 'No account with that email.';
  return err?.message ?? String(e);
}

export function AccountDialog() {
  const user = useCloud((s) => s.user);
  const recovery = useCloud((s) => s.recovery);
  return (
    <Modal title={recovery ? 'Set a new password' : user ? 'Your account' : 'Sign in to sync'} onClose={closeDialog} wide={!!user && !recovery}>
      {recovery ? <NewPassword /> : user ? <AccountPanel /> : <SignInPanel />}
    </Modal>
  );
}

/* ---------------- signed out ---------------- */

type Mode = 'signin' | 'signup' | 'reset' | 'magic';

function SignInPanel() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [providers, setProviders] = useState<OAuthProvider[]>([]);

  useEffect(() => {
    void enabledProviders().then(setProviders);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'signin')
      void run(async () => {
        await signIn(email.trim(), password);
        closeDialog();
        useStore.getState().toast('Signed in — your graph now syncs to the cloud', 'success');
      });
    else if (mode === 'signup')
      void run(async () => {
        const r = await signUp(email.trim(), password, name);
        if (r.needsConfirmation) setInfo('Almost done! We sent a confirmation link to your email. Open it on this device to finish creating your account.');
        else {
          closeDialog();
          useStore.getState().toast('Account created — your graph now syncs to the cloud', 'success');
        }
      });
    else if (mode === 'reset')
      void run(async () => {
        await sendPasswordReset(email.trim());
        setInfo('If an account exists for this email, a password-reset link is on its way.');
      });
    else
      void run(async () => {
        await sendMagicLink(email.trim());
        setInfo('Check your inbox for a sign-in link.');
      });
  };

  return (
    <div className="account">
      <p className="muted small">
        With an account your knowledge graph is stored securely in the cloud and stays in sync across your laptop, phone and any other browser. Without one, everything keeps working and stays in this browser only.
      </p>
      {(mode === 'signin' || mode === 'signup') && (
        <div className="tabs">
          <button className={mode === 'signin' ? 'on' : ''} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>
      )}
      {mode === 'reset' && <h4 className="account-sub">Reset your password</h4>}
      {mode === 'magic' && <h4 className="account-sub">Email me a sign-in link</h4>}

      <form className="auth-form" onSubmit={submit}>
        {mode === 'signup' && (
          <label>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown on your account" autoComplete="name" maxLength={80} />
          </label>
        )}
        <label>
          <span>Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" autoFocus />
        </label>
        {(mode === 'signin' || mode === 'signup') && (
          <label>
            <span>Password</span>
            <input
              type="password"
              required
              minLength={mode === 'signup' ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'At least 8 characters' : ''}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </label>
        )}
        {error && <p className="error small">{error}</p>}
        {info && <p className="ok small">{info}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy && <span className="spinner" />}
          {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Send sign-in link'}
        </button>
      </form>

      <div className="auth-links small">
        {mode === 'signin' && (
          <>
            <button className="link-btn" onClick={() => setMode('reset')}>
              Forgot password?
            </button>
            <button className="link-btn" onClick={() => setMode('magic')}>
              Sign in with an email link instead
            </button>
          </>
        )}
        {(mode === 'reset' || mode === 'magic') && (
          <button className="link-btn" onClick={() => setMode('signin')}>
            ← Back to sign in
          </button>
        )}
      </div>

      {providers.length > 0 && (mode === 'signin' || mode === 'signup') && (
        <div className="oauth">
          <span className="muted small">or</span>
          {providers.map((p) => (
            <button key={p} className="btn" disabled={busy} onClick={() => void run(() => signInWithProvider(p))}>
              Continue with {p === 'github' ? 'GitHub' : 'Google'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- password recovery ---------------- */

function NewPassword() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pw !== pw2) return setError('The passwords don’t match.');
        setBusy(true);
        setError('');
        try {
          await updatePassword(pw);
          useStore.getState().toast('Password updated', 'success');
          closeDialog();
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <span>New password</span>
        <input type="password" required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus />
      </label>
      <label>
        <span>Repeat</span>
        <input type="password" required minLength={8} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
      </label>
      {error && <p className="error small">{error}</p>}
      <button className="btn primary" type="submit" disabled={busy}>
        Save new password
      </button>
    </form>
  );
}

/* ---------------- signed in ---------------- */

function AccountPanel() {
  const user = useCloud((s) => s.user)!;
  const displayName = useCloud((s) => s.displayName);
  const workspaces = useCloud((s) => s.workspaces);
  const activeId = useCloud((s) => s.activeWorkspaceId);
  const status = useCloud((s) => s.status);
  const lastSyncedAt = useCloud((s) => s.lastSyncedAt);
  const syncError = useCloud((s) => s.error);
  const [name, setName] = useState(displayName);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newWs, setNewWs] = useState('');

  useEffect(() => setName(displayName), [displayName]);

  const run = async (key: string, fn: () => Promise<void>, okText?: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="account">
      <section className="acc-section">
        <h4>Profile</h4>
        <div className="opt-grid">
          <label>Email</label>
          <span>{user.email}</span>
          <label>Name</label>
          <div className="row gap">
            <input className="grow" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            <button className="btn small" disabled={busy !== '' || name.trim() === displayName} onClick={() => run('name', () => updateDisplayName(name), 'Name saved.')}>
              Save
            </button>
          </div>
          <label>Password</label>
          <div className="row gap">
            <input className="grow" type="password" placeholder="New password (min. 8 characters)" minLength={8} value={pw} autoComplete="new-password" onChange={(e) => setPw(e.target.value)} />
            <button
              className="btn small"
              disabled={busy !== '' || pw.length < 8}
              onClick={() =>
                run(
                  'pw',
                  async () => {
                    await updatePassword(pw);
                    setPw('');
                  },
                  'Password changed.',
                )
              }
            >
              Change
            </button>
          </div>
          <label>Sync</label>
          <div className="row gap">
            <span className={`sync-pill ${status}`}>{statusText(status)}</span>
            {lastSyncedAt > 0 && <span className="muted small">last synced {new Date(lastSyncedAt).toLocaleTimeString()}</span>}
            <button className="btn tiny" disabled={status === 'syncing'} onClick={() => void syncNow()}>
              Sync now
            </button>
          </div>
          {syncError && (
            <>
              <span />
              <span className="error small">{syncError}</span>
            </>
          )}
        </div>
      </section>

      <section className="acc-section">
        <h4>Workspaces</h4>
        <p className="muted small">Separate knowledge graphs — e.g. one per subject. All of them sync to every device you sign in on.</p>
        <ul className="ws-list">
          {workspaces.map((w) => (
            <li key={w.id} className={w.id === activeId ? 'active' : ''}>
              <span className="grow">{w.name}</span>
              {w.id === activeId ? (
                <span className="badge">open</span>
              ) : (
                <button className="btn tiny" disabled={busy !== ''} onClick={() => run('ws', () => switchWorkspace(w.id))}>
                  Open
                </button>
              )}
              <button
                className="btn tiny ghost danger"
                disabled={busy !== ''}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Delete workspace “${w.name}”?`,
                    body: 'All its pages and relations are deleted from the cloud and from every device. This cannot be undone.',
                    actions: [{ id: 'del', label: 'Delete workspace', danger: true }],
                  });
                  if (ok === 'del') await run('ws', () => deleteWorkspace(w.id), 'Workspace deleted.');
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newWs.trim()) return;
            void run('ws', async () => {
              await createWorkspace(newWs);
              setNewWs('');
            });
          }}
        >
          <input className="grow" placeholder="New workspace name" value={newWs} maxLength={120} onChange={(e) => setNewWs(e.target.value)} />
          <button className="btn small" type="submit" disabled={busy !== '' || !newWs.trim()}>
            + Create
          </button>
        </form>
      </section>

      {msg && <p className={msg.ok ? 'ok small' : 'error small'}>{msg.text}</p>}

      <section className="acc-section row gap">
        <button
          className="btn"
          disabled={busy !== ''}
          onClick={() =>
            run('out', async () => {
              await signOut();
              closeDialog();
              useStore.getState().toast('Signed out. This browser now shows its local (guest) graph.', 'info');
            })
          }
        >
          Sign out
        </button>
        <span className="muted small grow">Signing out removes your synced data from this device; it stays safe in the cloud.</span>
      </section>

      <section className="acc-section danger-zone">
        <h4>Delete account</h4>
        <p className="muted small">Permanently deletes your account and every workspace, page and relation stored in the cloud.</p>
        <button
          className="btn danger"
          disabled={busy !== ''}
          onClick={async () => {
            const ok = await confirmDialog({
              title: 'Delete your account permanently?',
              body: `This deletes ${user.email} and all ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} from the cloud. Export a backup first (💾) if you want to keep anything. This cannot be undone.`,
              actions: [{ id: 'del', label: 'Delete my account', danger: true }],
            });
            if (ok === 'del')
              await run('del', async () => {
                await deleteAccount();
                closeDialog();
                useStore.getState().toast('Your account and its data were deleted.', 'info');
              });
          }}
        >
          Delete account…
        </button>
      </section>
    </div>
  );
}

export function statusText(s: ReturnType<typeof useCloud.getState>['status']): string {
  switch (s) {
    case 'syncing':
      return 'Syncing…';
    case 'synced':
      return 'Synced';
    case 'offline':
      return 'Offline — changes are kept and will sync';
    case 'error':
      return 'Sync problem';
    default:
      return 'Not signed in';
  }
}
