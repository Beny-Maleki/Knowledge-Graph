import { useState } from 'react';
import { useStore } from '../store/store';
import { closeDialog, Modal } from './Modal';
import { CLAUDE_MODELS, OPENAI_PRESETS, useSettings, type Effort } from '../lib/settings';
import { pullFromGist, pushToGist } from '../lib/gist';
import { generateText } from '../lib/llm';
import { AIError } from '../lib/llm';

type Tab = 'ai' | 'sync' | 'appearance';

export function SettingsDialog() {
  const [tab, setTab] = useState<Tab>((useStore.getState().dialogArg as Tab) || 'ai');
  return (
    <Modal title="Settings" onClose={closeDialog} wide>
      <div className="tabs">
        <button className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>
          AI
        </button>
        <button className={tab === 'sync' ? 'on' : ''} onClick={() => setTab('sync')}>
          Sync
        </button>
        <button className={tab === 'appearance' ? 'on' : ''} onClick={() => setTab('appearance')}>
          Appearance
        </button>
      </div>
      {tab === 'ai' && <AITab />}
      {tab === 'sync' && <SyncTab />}
      {tab === 'appearance' && <AppearanceTab />}
    </Modal>
  );
}

function AITab() {
  const ai = useSettings((s) => s.ai);
  const setAI = useSettings((s) => s.setAI);
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; msg?: string }>({ state: 'idle' });
  const custom = !CLAUDE_MODELS.some((m) => m.id === ai.anthropicModel);

  const runTest = async () => {
    setTest({ state: 'running' });
    try {
      const out = await generateText({ system: 'You are a connection test.', prompt: 'Reply with exactly: OK', maxTokens: 2000 });
      setTest({ state: 'ok', msg: `Model replied: “${out.slice(0, 60)}”` });
    } catch (e) {
      setTest({ state: 'error', msg: e instanceof AIError ? `${e.message}${e.hint ? ' ' + e.hint : ''}` : String(e) });
    }
  };

  return (
    <div className="settings">
      <p className="muted small">
        AI powers <b>Digest</b>, <b>Expand</b>, <b>Write</b> and <b>Review</b>. Requests go straight from your browser to the provider you choose — there is no server in between. Everything else in the app works without AI.
      </p>
      <div className="seg big">
        <button className={ai.provider === 'anthropic' ? 'on' : ''} onClick={() => setAI({ provider: 'anthropic' })}>
          Claude (Anthropic)
        </button>
        <button className={ai.provider === 'openai' ? 'on' : ''} onClick={() => setAI({ provider: 'openai' })}>
          Local / OpenAI-compatible
        </button>
      </div>

      {ai.provider === 'anthropic' ? (
        <div className="opt-grid">
          <label>API key</label>
          <input type="password" autoComplete="off" placeholder="sk-ant-…" value={ai.anthropicKey} onChange={(e) => setAI({ anthropicKey: e.target.value })} />
          <span />
          <span className="muted small">
            Create one at{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">
              console.anthropic.com
            </a>
            . Usage is billed to your Anthropic account.
          </span>
          <label>Model</label>
          <div className="row gap">
            <select value={custom ? '__custom' : ai.anthropicModel} onChange={(e) => setAI({ anthropicModel: e.target.value === '__custom' ? '' : e.target.value })}>
              {CLAUDE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value="__custom">Other model id…</option>
            </select>
            {custom && <input className="grow" placeholder="model id" value={ai.anthropicModel} onChange={(e) => setAI({ anthropicModel: e.target.value })} />}
          </div>
          <label>Effort</label>
          <div className="seg">
            {(['low', 'medium', 'high'] as Effort[]).map((e) => (
              <button key={e} className={ai.effort === e ? 'on' : ''} onClick={() => setAI({ effort: e })}>
                {e === 'low' ? 'Fast' : e === 'medium' ? 'Balanced' : 'Thorough'}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="opt-grid">
          <label>Preset</label>
          <div className="chips">
            {OPENAI_PRESETS.map((p) => (
              <button key={p.label} className={`chip ${ai.openaiBaseUrl === p.baseUrl ? 'on' : ''}`} onClick={() => setAI({ openaiBaseUrl: p.baseUrl, openaiModel: p.model || ai.openaiModel })}>
                {p.label}
              </button>
            ))}
          </div>
          <label>Base URL</label>
          <input placeholder="http://localhost:11434/v1" value={ai.openaiBaseUrl} onChange={(e) => setAI({ openaiBaseUrl: e.target.value })} />
          <label>Model</label>
          <input placeholder="e.g. llama3.1, qwen2.5:14b" value={ai.openaiModel} onChange={(e) => setAI({ openaiModel: e.target.value })} />
          <label>API key</label>
          <input type="password" autoComplete="off" placeholder="(not needed for local servers)" value={ai.openaiKey} onChange={(e) => setAI({ openaiKey: e.target.value })} />
          <span />
          <div className="muted small">
            <b>Ollama:</b> start it with this site allowed, e.g. <code>OLLAMA_ORIGINS="{location.origin}" ollama serve</code>. Small local models may struggle with large inputs — prefer 7B+ instruction models.
          </div>
        </div>
      )}

      <div className="opt-grid">
        <label>Instructions</label>
        <textarea rows={2} placeholder="Optional, applied to every AI request, e.g. “Write notes in Persian” or “I'm a medical student”" value={ai.customInstructions} onChange={(e) => setAI({ customInstructions: e.target.value })} />
        <label>Storage</label>
        <label className="check">
          <input type="checkbox" checked={ai.rememberKeys} onChange={(e) => setAI({ rememberKeys: e.target.checked })} /> Remember keys on this device (otherwise only for this browser session)
        </label>
      </div>

      <div className="row gap">
        <button className="btn" onClick={runTest} disabled={test.state === 'running'}>
          {test.state === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        {test.state === 'ok' && <span className="ok small">✓ {test.msg}</span>}
        {test.state === 'error' && <span className="error small">{test.msg}</span>}
        <span className="grow" />
        <button className="link-btn small" onClick={() => useSettings.getState().forgetKeys()}>
          Forget all keys
        </button>
      </div>
    </div>
  );
}

function SyncTab() {
  const sync = useSettings((s) => s.sync);
  const setSync = useSettings((s) => s.setSync);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const push = async () => {
    setBusy('push');
    setMsg(null);
    try {
      const s = useStore.getState();
      const r = await pushToGist(sync.token, sync.gistId, s.data, s.workspaceName);
      setSync({ gistId: r.gistId, lastSync: Date.now() });
      setMsg({ ok: true, text: `Saved to your private gist.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  };
  const pull = async () => {
    setBusy('pull');
    setMsg(null);
    try {
      const r = await pullFromGist(sync.token, sync.gistId);
      useStore.getState().replaceData(r.data, r.name);
      setSync({ lastSync: Date.now() });
      setMsg({ ok: true, text: `Loaded ${Object.keys(r.data.nodes).length} pages from the gist (Undo is available).` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="settings">
      <p className="muted small">
        Your graph lives in this browser. To use it on several devices (or just to have an off-site backup), mirror it to a <b>private GitHub Gist</b>. Create a token at{' '}
        <a href="https://github.com/settings/tokens/new?scopes=gist&description=Knowledge%20Graph" target="_blank" rel="noopener noreferrer">
          github.com/settings/tokens
        </a>{' '}
        with only the <code>gist</code> scope.
      </p>
      <div className="opt-grid">
        <label>Token</label>
        <input type="password" autoComplete="off" placeholder="ghp_… or github_pat_…" value={sync.token} onChange={(e) => setSync({ token: e.target.value })} />
        <label>Gist ID</label>
        <input placeholder="(created automatically on first push — paste it on your other devices)" value={sync.gistId} onChange={(e) => setSync({ gistId: e.target.value.trim() })} />
        <label>Auto</label>
        <label className="check">
          <input type="checkbox" checked={sync.auto} onChange={(e) => setSync({ auto: e.target.checked })} /> Push automatically after changes, and load newer versions on start-up
        </label>
      </div>
      <div className="row gap">
        <button className="btn primary" disabled={!sync.token || !!busy} onClick={push}>
          {busy === 'push' ? 'Pushing…' : '↑ Push now'}
        </button>
        <button className="btn" disabled={!sync.token || !sync.gistId || !!busy} onClick={pull}>
          {busy === 'pull' ? 'Pulling…' : '↓ Pull (replace local)'}
        </button>
        {sync.lastSync > 0 && <span className="muted small">Last sync {new Date(sync.lastSync).toLocaleString()}</span>}
      </div>
      {msg && <p className={msg.ok ? 'ok small' : 'error small'}>{msg.text}</p>}
    </div>
  );
}

function AppearanceTab() {
  const theme = useStore((s) => s.theme);
  const showLinks = useStore((s) => s.showLinks);
  const showHulls = useStore((s) => s.showHulls);
  const showLabels = useStore((s) => s.showLabels);
  const setUI = useStore((s) => s.setUI);
  return (
    <div className="settings">
      <div className="opt-grid">
        <label>Theme</label>
        <div className="seg">
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => setUI({ theme: 'dark' })}>
            Dark
          </button>
          <button className={theme === 'light' ? 'on' : ''} onClick={() => setUI({ theme: 'light' })}>
            Light
          </button>
        </div>
        <label>Graph</label>
        <div className="col">
          <label className="check">
            <input type="checkbox" checked={showLinks} onChange={(e) => setUI({ showLinks: e.target.checked })} /> Show relations (cross-links)
          </label>
          <label className="check">
            <input type="checkbox" checked={showHulls} onChange={(e) => setUI({ showHulls: e.target.checked })} /> Shade unfolded groups
          </label>
          <label className="check">
            <input type="checkbox" checked={showLabels} onChange={(e) => setUI({ showLabels: e.target.checked })} /> Show labels
          </label>
        </div>
      </div>
    </div>
  );
}
