import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store/store';
import { AIError } from '../lib/llm';
import { aiReady, useSettings } from '../lib/settings';

export function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function closeDialog() {
  useStore.getState().openDialog(null);
}

export interface AITask<T> {
  running: boolean;
  progress: string;
  error: { message: string; hint?: string } | null;
  run: (fn: (signal: AbortSignal, onProgress: (chars: number, phase: 'thinking' | 'writing') => void) => Promise<T>) => Promise<T | undefined>;
  cancel: () => void;
}

/** Runs an AI call with cancellation, progress text and friendly errors. */
export function useAITask<T>(): AITask<T> {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<AITask<T>['error']>(null);
  const ctrl = useRef<AbortController | null>(null);
  const started = useRef(0);

  useEffect(() => () => ctrl.current?.abort(), []);

  const run: AITask<T>['run'] = async (fn) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setRunning(true);
    setError(null);
    setProgress('Starting…');
    started.current = Date.now();
    const tick = window.setInterval(() => {
      setProgress((p) => p.replace(/ · \d+s$/, '') + ` · ${Math.round((Date.now() - started.current) / 1000)}s`);
    }, 1000);
    try {
      return await fn(c.signal, (chars, phase) => {
        const secs = Math.round((Date.now() - started.current) / 1000);
        setProgress(phase === 'thinking' ? `Thinking… · ${secs}s` : `Writing… ${chars.toLocaleString()} characters · ${secs}s`);
      });
    } catch (err) {
      if (c.signal.aborted) return undefined;
      if (err instanceof AIError) setError({ message: err.message, hint: err.hint });
      else setError({ message: err instanceof Error ? err.message : String(err) });
      return undefined;
    } finally {
      window.clearInterval(tick);
      if (ctrl.current === c) {
        setRunning(false);
        setProgress('');
      }
    }
  };
  return {
    running,
    progress,
    error,
    run,
    cancel: () => {
      ctrl.current?.abort();
      setRunning(false);
      setProgress('');
    },
  };
}

export function AIStatus({ task }: { task: AITask<unknown> }) {
  if (task.running)
    return (
      <div className="ai-status running">
        <span className="spinner" /> {task.progress}
        <button className="btn tiny" onClick={task.cancel}>
          Cancel
        </button>
      </div>
    );
  if (task.error)
    return (
      <div className="ai-status error" role="alert">
        <b>{task.error.message}</b>
        {task.error.hint && <div className="small">{task.error.hint}</div>}
      </div>
    );
  return null;
}

export function AIRequired() {
  const ai = useSettings((s) => s.ai);
  if (aiReady(ai)) {
    const model = ai.provider === 'anthropic' ? ai.anthropicModel : `${ai.openaiModel} @ ${ai.openaiBaseUrl.replace(/^https?:\/\//, '')}`;
    return (
      <p className="muted small">
        Using <b>{model}</b> ·{' '}
        <button className="link-btn" onClick={() => useStore.getState().openDialog('settings')}>
          change
        </button>
      </p>
    );
  }
  return (
    <div className="callout">
      AI features need a model. Add an Anthropic API key or point to a local / OpenAI-compatible model in{' '}
      <button className="link-btn" onClick={() => useStore.getState().openDialog('settings')}>
        Settings → AI
      </button>
      .
    </div>
  );
}
