/**
 * Pure merge logic for cloud sync. Each page / relation is a separate row, so
 * two devices editing different pages never conflict. When the *same* item was
 * changed on both sides, the newer edit wins (by the item's own `updatedAt`),
 * and an edit always beats a deletion so nothing you worked on silently vanishes.
 */

export interface RemoteRow {
  id: string;
  data: unknown;
  deleted: boolean;
  updated_at: string;
}

type Entity = { updatedAt?: number; createdAt?: number };

const keyCache = new WeakMap<object, string>();

/** Order-independent serialisation (Postgres jsonb reorders object keys). */
export function stableKey(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  const cached = keyCache.get(v);
  if (cached !== undefined) return cached;
  let out: string;
  if (Array.isArray(v)) out = `[${v.map(stableKey).join(',')}]`;
  else {
    const o = v as Record<string, unknown>;
    out = `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(o[k])}`)
      .join(',')}}`;
  }
  keyCache.set(v, out);
  return out;
}

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return stableKey(a) === stableKey(b);
}

/** Ids whose local value differs from the last value known to be on the server. */
export function pendingChanges<T>(local: Record<string, T>, base: Record<string, T>): Set<string> {
  const out = new Set<string>();
  for (const id of Object.keys(local)) if (!same(local[id], base[id])) out.add(id);
  for (const id of Object.keys(base)) if (!(id in local)) out.add(id);
  return out;
}

const stamp = (e: Entity | undefined) => e?.updatedAt ?? e?.createdAt ?? 0;

/**
 * Fold pulled rows into `base` (mutated) and decide which remote values must be
 * written into the local graph. `patches` maps id → new value, or null to delete.
 * Items in `pending` that lose a conflict are removed from it.
 */
export function mergeRemote<T extends Entity>(
  rows: RemoteRow[],
  snapshot: Record<string, T>,
  base: Record<string, T>,
  pending: Set<string>,
  isValid: (data: unknown, id: string) => data is T,
): Map<string, T | null> {
  const patches = new Map<string, T | null>();
  for (const r of rows) {
    if (!r.deleted && !isValid(r.data, r.id)) continue;
    const remote = r.deleted ? undefined : (r.data as T);
    if (same(remote, base[r.id])) continue; // nothing new (e.g. our own earlier push)
    if (remote === undefined) delete base[r.id];
    else base[r.id] = remote;

    if (!pending.has(r.id)) {
      patches.set(r.id, remote ?? null);
      continue;
    }
    const local = snapshot[r.id];
    let remoteWins: boolean;
    if (local && remote) remoteWins = stamp(remote) > stamp(local);
    else if (!local && remote) remoteWins = true; // edited elsewhere beats deleted here
    else if (local && !remote) remoteWins = false; // edited here beats deleted elsewhere
    else remoteWins = true; // deleted on both sides
    if (remoteWins) {
      patches.set(r.id, remote ?? null);
      pending.delete(r.id);
    }
  }
  return patches;
}

/**
 * Apply patches to the *current* local values, skipping items the user edited
 * while the sync was in flight (those are pushed on the next round).
 */
export function applyPatches<T>(current: Record<string, T>, snapshot: Record<string, T>, patches: Map<string, T | null>): Record<string, T> | null {
  let next: Record<string, T> | null = null;
  for (const [id, v] of patches) {
    if (!same(current[id], snapshot[id])) continue;
    next ??= { ...current };
    if (v === null) delete next[id];
    else next[id] = v;
  }
  return next;
}
