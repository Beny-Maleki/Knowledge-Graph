import { create } from 'zustand';

interface ConfirmAction {
  id: string;
  label: string;
  danger?: boolean;
}

interface ConfirmOpts {
  title: string;
  body?: string;
  actions: ConfirmAction[];
}

interface State {
  opts: ConfirmOpts | null;
  resolve: ((v: string | null) => void) | null;
}

const useConfirm = create<State>(() => ({ opts: null, resolve: null }));

/** Promise-based confirmation dialog; resolves with the chosen action id or null. */
export function confirmDialog(opts: ConfirmOpts): Promise<string | null> {
  return new Promise((resolve) => {
    useConfirm.getState().resolve?.(null);
    useConfirm.setState({ opts, resolve });
  });
}

export function ConfirmHost() {
  const { opts, resolve } = useConfirm();
  if (!opts) return null;
  const close = (v: string | null) => {
    resolve?.(v);
    useConfirm.setState({ opts: null, resolve: null });
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(null)} onKeyDown={(e) => e.key === 'Escape' && close(null)}>
      <div className="modal confirm" role="alertdialog" aria-label={opts.title}>
        <h3>{opts.title}</h3>
        {opts.body && <p className="muted">{opts.body}</p>}
        <div className="row end gap">
          <button className="btn" onClick={() => close(null)} autoFocus>
            Cancel
          </button>
          {opts.actions.map((a) => (
            <button key={a.id} className={`btn ${a.danger ? 'danger' : 'primary'}`} onClick={() => close(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
