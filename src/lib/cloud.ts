/**
 * Accounts + cloud sync (Supabase).
 *
 * - Signed out ("guest"): the graph lives only in this browser, as before.
 * - Signed in: each workspace is mirrored to Postgres, one row per page and per
 *   relation. A local copy is kept per workspace so the app opens instantly and
 *   works offline; changes sync in the background (on edit, every 30 s, on focus).
 */
import { create } from 'zustand';
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import { isAuthRetryableFetchError, type AuthChangeEvent, type Session, type User } from '@supabase/supabase-js';
import { appRedirectUrl, supabase, type OAuthProvider } from './supabase';
import type { GraphData, KLink, KNode } from '../types';
import { applyPatches, mergeRemote, pendingChanges, type RemoteRow } from './syncMerge';
import { useStore } from '../store/store';
import { deleteSaved, getStorageTarget, loadGuest, loadSaved, safeLocalGet, safeLocalSet, switchTarget } from '../store/persist';
import { confirmDialog } from '../components/Confirm';

export type SyncStatus = 'signed-out' | 'syncing' | 'synced' | 'offline' | 'error';

export interface Workspace {
  id: string;
  name: string;
  updated_at: string;
}

interface CloudState {
  user: { id: string; email: string } | null;
  displayName: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  status: SyncStatus;
  lastSyncedAt: number;
  error: string;
  /** Opened from a password-reset email: ask for a new password. */
  recovery: boolean;
}

export const useCloud = create<CloudState>(() => ({
  user: null,
  displayName: '',
  workspaces: [],
  activeWorkspaceId: null,
  status: 'signed-out',
  lastSyncedAt: 0,
  error: '',
  recovery: false,
}));

/* ---------------- local bookkeeping ---------------- */

const ACTIVE_KEY = 'kg:cloud:active';
const lastWsKey = (userId: string) => `kg:cloud:last-ws:${userId}`;
const metaKey = (wsId: string) => `kg:cloudmeta:v1:${wsId}`;

interface ActiveInfo {
  userId: string;
  email: string;
  workspaceId: string;
}

/** Last value of every page/relation known to be on the server, plus the pull cursor. */
interface SyncMeta {
  base: GraphData;
  name: string;
  cursor: string | null;
}

export function readActive(): ActiveInfo | null {
  return safeLocalGet<ActiveInfo>(ACTIVE_KEY);
}

async function loadMeta(wsId: string): Promise<SyncMeta> {
  try {
    const m = await idbGet<SyncMeta>(metaKey(wsId));
    if (m) return m;
  } catch {
    /* ignore */
  }
  return { base: { nodes: {}, links: {} }, name: '', cursor: null };
}

async function saveMeta(wsId: string, m: SyncMeta) {
  try {
    await idbSet(metaKey(wsId), m);
  } catch {
    /* ignore */
  }
}

/* ---------------- validation of rows coming from the server ---------------- */

const isNode = (d: unknown, id: string): d is KNode => {
  const n = d as KNode;
  return !!n && typeof n === 'object' && n.id === id && typeof n.title === 'string' && typeof n.content === 'string' && Array.isArray(n.tags);
};
const isLink = (d: unknown, id: string): d is KLink => {
  const l = d as KLink;
  return !!l && typeof l === 'object' && l.id === id && typeof l.source === 'string' && typeof l.target === 'string';
};

/* ---------------- errors ---------------- */

function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String((err as { message?: string })?.message ?? err);
  return isAuthRetryableFetchError(err) || /fetch|network|load failed/i.test(msg);
}

function describe(err: unknown): string {
  const e = err as { message?: string; code?: string };
  return e?.message || String(err);
}

/* ---------------- sync engine ---------------- */

let running: Promise<void> | null = null;
let again = false;

/** Run a sync round now (coalesces with one already in flight). */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncRound();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function fetchRows(table: 'kg_nodes' | 'kg_links', wsId: string, since: string | null): Promise<RemoteRow[]> {
  const out: RemoteRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = supabase.from(table).select('id,data,deleted,updated_at').eq('workspace_id', wsId);
    q = since ? q.gt('updated_at', since) : q.eq('deleted', false);
    const { data, error } = await q.order('updated_at').order('id').range(from, from + page - 1);
    if (error) throw error;
    out.push(...(data as RemoteRow[]));
    if (!data || data.length < page) break;
  }
  return out;
}

async function pushRows(table: 'kg_nodes' | 'kg_links', rows: { workspace_id: string; id: string; data: unknown; deleted: boolean }[]) {
  // batches of ≤ 200 rows and ≈ 1.5 MB per request
  let batch: typeof rows = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const { error } = await supabase.from(table).upsert(batch, { onConflict: 'workspace_id,id' });
    if (error) throw error;
    batch = [];
    bytes = 0;
  };
  for (const r of rows) {
    const size = JSON.stringify(r.data).length;
    if (batch.length && (batch.length >= 200 || bytes + size > 1_500_000)) await flush();
    batch.push(r);
    bytes += size;
  }
  await flush();
}

async function syncRound() {
  const cloud = useCloud.getState();
  const target = getStorageTarget();
  if (!cloud.user || target.kind !== 'cloud') return;
  const wsId = target.workspaceId;
  const stillActive = () => {
    const t = getStorageTarget();
    return t.kind === 'cloud' && t.workspaceId === wsId && useCloud.getState().user?.id === cloud.user?.id;
  };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    useCloud.setState({ status: 'offline', error: '' });
    return;
  }
  useCloud.setState({ status: 'syncing' });
  try {
    const meta = await loadMeta(wsId);
    const base: GraphData = { nodes: { ...meta.base.nodes }, links: { ...meta.base.links } };

    // 1. workspace list + name
    const { data: wsRows, error: wsErr } = await supabase.from('workspaces').select('id,name,updated_at').order('updated_at', { ascending: false });
    if (wsErr) throw wsErr;
    useCloud.setState({ workspaces: wsRows as Workspace[] });
    const remoteWs = (wsRows as Workspace[]).find((w) => w.id === wsId);
    if (!remoteWs) {
      if (!stillActive()) return;
      useStore.getState().toast('This workspace was deleted on another device.', 'info');
      await openFirstWorkspace();
      return;
    }

    // 2. pull everything that changed since the last round (with a 60 s overlap)
    const since = meta.cursor ? new Date(Date.parse(meta.cursor) - 60_000).toISOString() : null;
    const [rNodes, rLinks] = await Promise.all([fetchRows('kg_nodes', wsId, since), fetchRows('kg_links', wsId, since)]);
    if (!stillActive()) return;
    let cursor = meta.cursor;
    for (const r of [...rNodes, ...rLinks]) if (!cursor || r.updated_at > cursor) cursor = r.updated_at;

    // 3. merge
    const snapshot = useStore.getState().data;
    const snapName = useStore.getState().workspaceName;
    const pNodes = pendingChanges(snapshot.nodes, base.nodes);
    const pLinks = pendingChanges(snapshot.links, base.links);
    const nodePatches = mergeRemote(rNodes, snapshot.nodes, base.nodes, pNodes, isNode);
    const linkPatches = mergeRemote(rLinks, snapshot.links, base.links, pLinks, isLink);
    let nameUpdate: string | undefined;
    const localRenamed = snapName !== meta.name;
    if (!localRenamed && remoteWs.name !== meta.name) nameUpdate = remoteWs.name;
    if (nodePatches.size || linkPatches.size || nameUpdate !== undefined) {
      const cur = useStore.getState().data;
      const nodes = applyPatches(cur.nodes, snapshot.nodes, nodePatches) ?? cur.nodes;
      const links = applyPatches(cur.links, snapshot.links, linkPatches) ?? cur.links;
      if (nodes !== cur.nodes || links !== cur.links || nameUpdate !== undefined) {
        useStore.getState().applyRemote({ nodes, links }, nameUpdate);
      }
    }

    // 4. push local changes
    const nodeRows = [...pNodes].map((id) => ({ workspace_id: wsId, id, data: snapshot.nodes[id] ?? {}, deleted: !snapshot.nodes[id] }));
    const linkRows = [...pLinks].map((id) => ({ workspace_id: wsId, id, data: snapshot.links[id] ?? {}, deleted: !snapshot.links[id] }));
    // nodes first so relations never point at pages the server hasn't seen
    await pushRows('kg_nodes', nodeRows);
    await pushRows('kg_links', linkRows);
    for (const id of pNodes) {
      if (snapshot.nodes[id]) base.nodes[id] = snapshot.nodes[id];
      else delete base.nodes[id];
    }
    for (const id of pLinks) {
      if (snapshot.links[id]) base.links[id] = snapshot.links[id];
      else delete base.links[id];
    }
    let name = nameUpdate ?? meta.name;
    if (localRenamed && snapName.trim()) {
      const { error } = await supabase.from('workspaces').update({ name: snapName.trim().slice(0, 120) }).eq('id', wsId);
      if (error) throw error;
      name = snapName;
      useCloud.setState({ workspaces: useCloud.getState().workspaces.map((w) => (w.id === wsId ? { ...w, name } : w)) });
    }
    await saveMeta(wsId, { base, name, cursor });
    if (stillActive()) useCloud.setState({ status: 'synced', lastSyncedAt: Date.now(), error: '' });
  } catch (err) {
    if (isNetworkError(err)) useCloud.setState({ status: 'offline', error: '' });
    else useCloud.setState({ status: 'error', error: describe(err) });
  }
}

/* ---------------- workspaces ---------------- */

async function openWorkspace(ws: Workspace) {
  const user = useCloud.getState().user;
  if (!user) return;
  const cached = await loadSaved({ kind: 'cloud', workspaceId: ws.id });
  await switchTarget({ kind: 'cloud', workspaceId: ws.id }, cached?.data ?? { nodes: {}, links: {} }, cached?.name ?? ws.name);
  safeLocalSet(ACTIVE_KEY, { userId: user.id, email: user.email, workspaceId: ws.id } satisfies ActiveInfo);
  safeLocalSet(lastWsKey(user.id), ws.id);
  useCloud.setState({ activeWorkspaceId: ws.id });
  if (!cached) {
    // first time on this device: make sure the name base matches so it isn't pushed back
    const meta = await loadMeta(ws.id);
    await saveMeta(ws.id, { ...meta, name: ws.name });
  }
  await syncNow();
}

async function openFirstWorkspace() {
  const list = useCloud.getState().workspaces;
  if (list.length) await openWorkspace(list[0]);
  else await createWorkspace('My knowledge');
}

export async function createWorkspace(name: string, data?: GraphData): Promise<void> {
  const user = useCloud.getState().user;
  if (!user) return;
  const { data: row, error } = await supabase
    .from('workspaces')
    .insert({ name: name.trim().slice(0, 120) || 'My knowledge' })
    .select('id,name,updated_at')
    .single();
  if (error) throw error;
  const ws = row as Workspace;
  useCloud.setState({ workspaces: [ws, ...useCloud.getState().workspaces] });
  await saveMeta(ws.id, { base: { nodes: {}, links: {} }, name: ws.name, cursor: null });
  await switchTarget({ kind: 'cloud', workspaceId: ws.id }, data ?? { nodes: {}, links: {} }, ws.name);
  safeLocalSet(ACTIVE_KEY, { userId: user.id, email: user.email, workspaceId: ws.id } satisfies ActiveInfo);
  safeLocalSet(lastWsKey(user.id), ws.id);
  useCloud.setState({ activeWorkspaceId: ws.id });
  await syncNow();
}

export async function switchWorkspace(id: string) {
  if (id === useCloud.getState().activeWorkspaceId) return;
  await syncNow(); // push what's pending in the current one first
  const ws = useCloud.getState().workspaces.find((w) => w.id === id);
  if (ws) await openWorkspace(ws);
}

export async function deleteWorkspace(id: string) {
  const { error } = await supabase.from('workspaces').delete().eq('id', id);
  if (error) throw error;
  await forgetWorkspaceLocally(id);
  useCloud.setState({ workspaces: useCloud.getState().workspaces.filter((w) => w.id !== id) });
  if (useCloud.getState().activeWorkspaceId === id) await openFirstWorkspace();
}

async function forgetWorkspaceLocally(id: string) {
  await deleteSaved({ kind: 'cloud', workspaceId: id });
  try {
    await idbDel(metaKey(id));
  } catch {
    /* ignore */
  }
}

/* ---------------- session lifecycle ---------------- */

let activating: { id: string; promise: Promise<void> } | null = null;

/** Load (or create) the user's workspaces; concurrent calls for the same user share one run. */
function activateUser(user: User): Promise<void> {
  if (activating && activating.id === user.id) return activating.promise;
  const promise = doActivateUser(user).finally(() => {
    if (activating?.promise === promise) activating = null;
  });
  activating = { id: user.id, promise };
  return promise;
}

async function doActivateUser(user: User) {
  const email = user.email ?? '';
  const prev = useCloud.getState().user;
  const cached = readActive();
  if (cached && cached.userId !== user.id) await clearLocalCloudData(cached.userId);
  useCloud.setState({ user: { id: user.id, email }, status: 'syncing', error: '' });
  if (!prev || prev.id !== user.id || !useCloud.getState().displayName) void loadProfile(user.id);

  const { data: wsRows, error } = await supabase.from('workspaces').select('id,name,updated_at').order('updated_at', { ascending: false });
  if (error) {
    useCloud.setState(isNetworkError(error) ? { status: 'offline' } : { status: 'error', error: describe(error) });
    return;
  }
  const list = wsRows as Workspace[];
  useCloud.setState({ workspaces: list });

  const t = getStorageTarget();
  if (t.kind === 'cloud' && list.some((w) => w.id === t.workspaceId)) {
    useCloud.setState({ activeWorkspaceId: t.workspaceId });
    await syncNow();
    return;
  }
  if (!list.length) {
    // First sign-in for this account: offer to bring this browser's graph along.
    const guest = t.kind === 'guest' ? { name: useStore.getState().workspaceName, data: useStore.getState().data } : await loadGuest();
    const count = Object.keys(guest.data.nodes).length;
    let copy = false;
    if (count > 0) {
      const choice = await confirmDialog({
        title: 'Copy this browser’s graph to your account?',
        body: `“${guest.name}” has ${count} page${count === 1 ? '' : 's'} saved only in this browser. Copy it into your account so it syncs everywhere, or start with an empty graph.`,
        actions: [
          { id: 'empty', label: 'Start empty' },
          { id: 'copy', label: 'Copy to my account' },
        ],
      });
      copy = choice === 'copy';
    }
    try {
      await createWorkspace(copy ? guest.name : 'My knowledge', copy ? guest.data : undefined);
    } catch (e) {
      useCloud.setState({ status: 'error', error: describe(e) });
    }
    return;
  }
  const lastId = safeLocalGet<string>(lastWsKey(user.id));
  await openWorkspace(list.find((w) => w.id === lastId) ?? list[0]);
}

async function loadProfile(userId: string) {
  const { data } = await supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle();
  if (data && useCloud.getState().user?.id === userId) useCloud.setState({ displayName: (data as { display_name: string | null }).display_name ?? '' });
}

async function clearLocalCloudData(userId?: string) {
  const ids = new Set(useCloud.getState().workspaces.map((w) => w.id));
  const active = readActive();
  if (active) ids.add(active.workspaceId);
  for (const id of ids) await forgetWorkspaceLocally(id);
  try {
    localStorage.removeItem(ACTIVE_KEY);
    if (userId) localStorage.removeItem(lastWsKey(userId));
  } catch {
    /* ignore */
  }
}

/** Back to the browser-only graph; removes this account's cached copies from the device. */
async function resetToGuest() {
  const userId = useCloud.getState().user?.id ?? readActive()?.userId;
  await clearLocalCloudData(userId);
  const guest = await loadGuest();
  await switchTarget({ kind: 'guest' }, guest.data, guest.name);
  useCloud.setState({ user: null, displayName: '', workspaces: [], activeWorkspaceId: null, status: 'signed-out', error: '', recovery: false });
}

function onAuthEvent(event: AuthChangeEvent, session: Session | null) {
  const current = useCloud.getState().user;
  if (event === 'PASSWORD_RECOVERY') {
    useCloud.setState({ recovery: true });
    useStore.getState().openDialog('account');
  }
  if ((event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') && session?.user && session.user.id !== current?.id) {
    void activateUser(session.user);
  } else if (event === 'SIGNED_OUT' && current) {
    void resetToGuest();
  } else if (event === 'USER_UPDATED' && session?.user && current) {
    useCloud.setState({ user: { id: session.user.id, email: session.user.email ?? current.email } });
  }
}

/** Show a cached cloud workspace immediately on start-up (before the network answers). */
export function primeFromCache(): { kind: 'cloud'; workspaceId: string } | null {
  const active = readActive();
  if (!active) return null;
  useCloud.setState({ user: { id: active.userId, email: active.email }, activeWorkspaceId: active.workspaceId, status: 'syncing' });
  return { kind: 'cloud', workspaceId: active.workspaceId };
}

export async function bootCloud() {
  supabase.auth.onAuthStateChange((event, session) => {
    // Never call Supabase inside this callback directly; defer.
    window.setTimeout(() => onAuthEvent(event, session), 0);
  });
  const { data, error } = await supabase.auth.getSession();
  // Remove ?code=… / error params left by email links and OAuth redirects.
  const url = new URL(window.location.href);
  const authParams = ['code', 'error', 'error_code', 'error_description', 'type'];
  if (authParams.some((p) => url.searchParams.has(p))) {
    const desc = url.searchParams.get('error_description');
    if (desc) useStore.getState().toast(`Sign-in link problem: ${desc}`, 'error');
    for (const p of authParams) url.searchParams.delete(p);
    window.history.replaceState(null, '', url.toString());
  }
  if (data.session?.user) {
    await activateUser(data.session.user);
  } else if (readActive()) {
    if (error && isNetworkError(error)) useCloud.setState({ status: 'offline' });
    else await resetToGuest();
  }

  // background sync triggers
  let debounce: number | undefined;
  useStore.subscribe((s, prev) => {
    if (s.data === prev.data && s.workspaceName === prev.workspaceName) return;
    if (!useCloud.getState().user || getStorageTarget().kind !== 'cloud') return;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void syncNow(), 2000);
  });
  window.setInterval(() => {
    if (document.visibilityState === 'visible' && useCloud.getState().user) void syncNow();
  }, 30_000);
  window.addEventListener('focus', () => useCloud.getState().user && void syncNow());
  window.addEventListener('online', () => {
    const u = useCloud.getState().user;
    if (!u) return;
    if (useCloud.getState().workspaces.length) void syncNow();
    else void supabase.auth.getSession().then(({ data: d }) => d.session?.user && activateUser(d.session.user));
  });
}

/* ---------------- account actions (used by the Account dialog) ---------------- */

export async function signUp(email: string, password: string, displayName: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName.trim() || undefined }, emailRedirectTo: appRedirectUrl() },
  });
  if (error) throw error;
  return { needsConfirmation: !data.session };
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function sendMagicLink(email: string) {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: appRedirectUrl(), shouldCreateUser: false } });
  if (error) throw error;
}

export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: appRedirectUrl() });
  if (error) throw error;
}

export async function signInWithProvider(provider: OAuthProvider) {
  const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: appRedirectUrl() } });
  if (error) throw error;
}

export async function updatePassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  useCloud.setState({ recovery: false });
}

export async function updateDisplayName(name: string) {
  const user = useCloud.getState().user;
  if (!user) return;
  const { error } = await supabase.from('profiles').update({ display_name: name.trim().slice(0, 80) || null }).eq('id', user.id);
  if (error) throw error;
  useCloud.setState({ displayName: name.trim() });
}

export async function signOut() {
  try {
    if (navigator.onLine) await syncNow();
  } catch {
    /* best effort */
  }
  // 'local' keeps your other devices signed in.
  await supabase.auth.signOut({ scope: 'local' });
  await resetToGuest();
}

export async function deleteAccount() {
  const { error } = await supabase.rpc('delete_my_account');
  if (error) throw error;
  await supabase.auth.signOut({ scope: 'local' });
  await resetToGuest();
}
