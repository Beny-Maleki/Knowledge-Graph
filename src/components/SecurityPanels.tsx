import { useEffect, useState } from 'react';
import { confirmDialog } from './Confirm';
import { closeDialog } from './Modal';
import { useStore } from '../store/store';
import { finishTotpEnrollment, listTotpFactors, removeTotpFactor, startTotpEnrollment, useCloud, verifyTotp, type TotpEnrollment } from '../lib/cloud';
import { supabase, SUPABASE_URL } from '../lib/supabase';

function msg(e: unknown): string {
  const err = e as { message?: string; code?: string };
  if (err?.code === 'mfa_verification_failed' || /invalid totp/i.test(err?.message ?? '')) return 'That code is not correct. Codes change every 30 seconds — try the current one.';
  return err?.message ?? String(e);
}

function CodeInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <input
      className="code-input"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="123456"
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );
}

/* ---------------- sign-in step: enter the authenticator code ---------------- */

export function MfaVerify() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await verifyTotp(code);
          closeDialog();
          useStore.getState().toast('Verified — welcome back', 'success');
        } catch (err) {
          setError(msg(err));
          setCode('');
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>Open <b>Google Authenticator</b> (or your authenticator app) and enter the 6-digit code for <b>Knowledge Graph</b>.</p>
      <CodeInput value={code} onChange={setCode} autoFocus />
      {error && <p className="error small">{error}</p>}
      <button className="btn primary" type="submit" disabled={busy || code.length !== 6}>
        {busy && <span className="spinner" />} Verify
      </button>
    </form>
  );
}

/* ---------------- set up / manage the authenticator app ---------------- */

export function TwoFactorSection({ required }: { required?: boolean }) {
  const [factors, setFactors] = useState<{ id: string; friendly_name?: string; created_at: string }[] | null>(null);
  const [enroll, setEnroll] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const role = useCloud((s) => s.role);

  const refresh = () =>
    listTotpFactors()
      .then(setFactors)
      .catch(() => setFactors([]));
  useEffect(() => {
    void refresh();
  }, []);

  const begin = async () => {
    setBusy(true);
    setError('');
    try {
      setEnroll(await startTotpEnrollment());
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enroll) return;
    setBusy(true);
    setError('');
    try {
      await finishTotpEnrollment(enroll.factorId, code);
      setEnroll(null);
      setCode('');
      await refresh();
      useStore.getState().toast('Two-factor authentication is on', 'success');
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="acc-section">
      <h4>Two-factor authentication</h4>
      {required && (
        <div className="callout">
          Admin accounts must use two-factor authentication. Set it up below to unlock your account.
        </div>
      )}
      {factors && factors.length > 0 && !enroll && (
        <>
          <p className="ok small">✓ On — sign-ins ask for a code from your authenticator app.</p>
          {factors.map((f) => (
            <div key={f.id} className="row gap small">
              <span className="grow">📱 {f.friendly_name || 'Authenticator app'} · added {new Date(f.created_at).toLocaleDateString()}</span>
              <button
                className="btn tiny ghost danger"
                disabled={busy}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: 'Turn off two-factor authentication?',
                    body: role === 'admin' ? 'Admin accounts need it: your admin access will be locked until you set it up again.' : 'Your account will be protected by your password only.',
                    actions: [{ id: 'off', label: 'Turn off', danger: true }],
                  });
                  if (ok !== 'off') return;
                  setBusy(true);
                  try {
                    await removeTotpFactor(f.id);
                    await refresh();
                  } catch (e) {
                    setError(msg(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </>
      )}
      {factors && factors.length === 0 && !enroll && (
        <>
          <p className="muted small">
            Protect your account with a code from <b>Google Authenticator</b> (or Authy, 1Password, Microsoft Authenticator…). Free, works offline, and no emails or texts are sent.
          </p>
          <button className="btn primary" onClick={begin} disabled={busy}>
            {busy && <span className="spinner" />} Set up authenticator app
          </button>
        </>
      )}
      {enroll && (
        <form className="enroll" onSubmit={finish}>
          <ol className="small">
            <li>
              In Google Authenticator tap <b>+</b> → <b>Scan a QR code</b>.
            </li>
            <li>Scan this code (or enter the key manually):</li>
          </ol>
          <div className="qr-wrap">
            <img className="qr" src={enroll.qr} alt="QR code for your authenticator app" width={180} height={180} />
            <code className="secret">{enroll.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </div>
          <ol className="small" start={3}>
            <li>Enter the 6-digit code the app shows:</li>
          </ol>
          <div className="row gap">
            <CodeInput value={code} onChange={setCode} autoFocus />
            <button className="btn primary" type="submit" disabled={busy || code.length !== 6}>
              {busy && <span className="spinner" />} Turn on
            </button>
            <button type="button" className="btn ghost" onClick={() => setEnroll(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/* ---------------- Claude connector tokens ---------------- */

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `kgm_${b64}`;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function connectorUrl(token: string) {
  return `${SUPABASE_URL}/functions/v1/mcp/${token}`;
}

const EXPIRY: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'Never', days: null },
];

export function ConnectClaudeSection() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [name, setName] = useState('claude.ai');
  const [expiry, setExpiry] = useState(90);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const { data, error: err } = await supabase.from('mcp_tokens').select('id,name,token_prefix,created_at,last_used_at,expires_at').order('created_at', { ascending: false });
    if (err) setError(msg(err));
    else setTokens(data as TokenRow[]);
  };
  useEffect(() => {
    void load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const token = randomToken();
      const days = EXPIRY.find((x) => x.days === expiry || (x.days === null && expiry === 0))?.days ?? null;
      const { error: err } = await supabase.from('mcp_tokens').insert({
        name: name.trim().slice(0, 60) || 'claude.ai',
        token_hash: await sha256Hex(token),
        token_prefix: token.slice(4, 12),
        expires_at: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
      });
      if (err) throw err;
      setFresh(token);
      setCopied(false);
      await load();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="acc-section">
      <h4>Connect Claude</h4>
      <p className="muted small">
        Let Claude read your graph and add pages and relations to it. Create a connector link, then in <b>claude.ai</b> open <b>Settings → Connectors → Add custom connector</b>, name it “Knowledge Graph” and paste the link. In a chat, ask e.g. “add what we just discussed to my knowledge graph”.
      </p>

      {fresh && (
        <div className="token-fresh">
          <b>Your connector link — copy it now, it won’t be shown again:</b>
          <div className="row gap">
            <input className="grow mono" readOnly value={connectorUrl(fresh)} onFocus={(e) => e.target.select()} />
            <button
              className="btn small primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(connectorUrl(fresh));
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <p className="muted small">Anyone with this link can read and change your graph — treat it like a password. Revoke it below if it leaks.</p>
          <button className="link-btn small" onClick={() => setFresh(null)}>
            Done
          </button>
        </div>
      )}

      {tokens && tokens.length > 0 && (
        <ul className="ws-list">
          {tokens.map((t) => {
            const expired = t.expires_at && Date.parse(t.expires_at) < Date.now();
            return (
              <li key={t.id}>
                <span className="grow">
                  <b>{t.name}</b> <code className="muted">kgm_{t.token_prefix}…</code>
                  <span className="muted small">
                    {' '}
                    · created {new Date(t.created_at).toLocaleDateString()} · {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleString()}` : 'never used'} ·{' '}
                    {expired ? <span className="error">expired</span> : t.expires_at ? `expires ${new Date(t.expires_at).toLocaleDateString()}` : 'no expiry'}
                  </span>
                </span>
                <button
                  className="btn tiny ghost danger"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: `Revoke “${t.name}”?`,
                      body: 'Claude (or anything else using this link) loses access immediately.',
                      actions: [{ id: 'rev', label: 'Revoke', danger: true }],
                    });
                    if (ok !== 'rev') return;
                    const { error: err } = await supabase.from('mcp_tokens').delete().eq('id', t.id);
                    if (err) setError(msg(err));
                    await load();
                  }}
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form className="row gap wrap" onSubmit={create}>
        <input className="grow" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. claude.ai" />
        <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} aria-label="Expires after">
          {EXPIRY.map((x) => (
            <option key={x.label} value={x.days ?? 0}>
              Expires: {x.label}
            </option>
          ))}
        </select>
        <button className="btn small" type="submit" disabled={busy}>
          {busy && <span className="spinner" />} + Create connector link
        </button>
      </form>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
