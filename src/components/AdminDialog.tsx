import { useEffect, useState } from 'react';
import { closeDialog, Modal } from './Modal';
import { confirmDialog } from './Confirm';
import { supabase } from '../lib/supabase';
import { useCloud, type Role } from '../lib/cloud';

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed: boolean;
  mfa_enabled: boolean;
  workspaces: number;
  pages: number;
}

const ROLE_HELP: Record<Role, string> = {
  pending: 'No cloud access (default for new sign-ups)',
  member: 'Cloud sync, workspaces and the Claude connector',
  admin: 'Member + manage users (requires 2FA)',
};

/** User management for admins. All checks happen in the database (admin + 2FA session). */
export function AdminDialog() {
  const me = useCloud((s) => s.user);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [filter, setFilter] = useState<'all' | Role>('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    const { data, error: err } = await supabase.rpc('admin_list_users');
    if (err) setError(err.message);
    else {
      setError('');
      setUsers(data as UserRow[]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const setRole = async (u: UserRow, role: Role) => {
    if (role === u.role) return;
    if (role === 'admin') {
      const ok = await confirmDialog({
        title: `Make ${u.email} an admin?`,
        body: 'Admins can approve, change and delete every user. They must use two-factor authentication.',
        actions: [{ id: 'yes', label: 'Make admin', danger: true }],
      });
      if (ok !== 'yes') return;
    }
    setBusy(u.id);
    const { error: err } = await supabase.rpc('admin_set_role', { target: u.id, new_role: role });
    setBusy('');
    if (err) setError(err.message);
    await load();
  };

  const remove = async (u: UserRow) => {
    const ok = await confirmDialog({
      title: `Delete ${u.email}?`,
      body: `Permanently deletes the account and its ${u.workspaces} workspace(s) / ${u.pages} page(s). This cannot be undone.`,
      actions: [{ id: 'del', label: 'Delete user', danger: true }],
    });
    if (ok !== 'del') return;
    setBusy(u.id);
    const { error: err } = await supabase.rpc('admin_delete_user', { target: u.id });
    setBusy('');
    if (err) setError(err.message);
    await load();
  };

  const shown = (users ?? []).filter((u) => filter === 'all' || u.role === filter);
  const pendingCount = (users ?? []).filter((u) => u.role === 'pending').length;

  return (
    <Modal title="Users" onClose={closeDialog} wide>
      <div className="row gap wrap">
        <div className="seg">
          {(['all', 'pending', 'member', 'admin'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? `All (${users?.length ?? 0})` : f === 'pending' ? `Pending (${pendingCount})` : f[0].toUpperCase() + f.slice(1) + 's'}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button className="btn small" onClick={() => void load()}>
          ↻ Refresh
        </button>
      </div>
      <p className="muted small">New sign-ups are <b>pending</b> and can only use the app locally. Approve them as <b>member</b> to unlock cloud sync and the Claude connector. Admins can't see anyone's notes — only these account details.</p>
      {error && <p className="error small">{error}</p>}
      {!users && !error && (
        <p className="muted">
          <span className="spinner" /> Loading…
        </p>
      )}
      {users && (
        <div className="table-wrap">
          <table className="users">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>2FA</th>
                <th>Data</th>
                <th>Joined / last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id} className={u.role === 'pending' ? 'pending' : ''}>
                  <td>
                    <b>{u.display_name || '—'}</b>
                    <div className="muted small">
                      {u.email}
                      {!u.email_confirmed && <span className="badge upd"> unconfirmed</span>}
                    </div>
                  </td>
                  <td>
                    <select value={u.role} disabled={busy === u.id} onChange={(e) => void setRole(u, e.target.value as Role)} title={ROLE_HELP[u.role]}>
                      <option value="pending">pending</option>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>{u.mfa_enabled ? '✓' : <span className="muted">—</span>}</td>
                  <td className="small">
                    {u.workspaces} ws · {u.pages} pages
                  </td>
                  <td className="small muted">
                    {new Date(u.created_at).toLocaleDateString()}
                    <br />
                    {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : 'never'}
                  </td>
                  <td>
                    {u.id !== me?.id && (
                      <button className="btn tiny ghost danger" disabled={busy === u.id} onClick={() => void remove(u)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    No users here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
