import { describe, expect, it } from 'vitest';
import { applyPatches, mergeRemote, pendingChanges, same, stableKey, type RemoteRow } from './syncMerge';

type N = { id: string; title: string; updatedAt: number };
const n = (id: string, title: string, updatedAt = 1): N => ({ id, title, updatedAt });
const isN = (d: unknown, id: string): d is N => !!d && typeof d === 'object' && (d as N).id === id;
const row = (id: string, data: N | null, at = '2026-01-01T00:00:00Z'): RemoteRow => ({ id, data: data ?? {}, deleted: !data, updated_at: at });

describe('sync merge', () => {
  it('compares values regardless of key order', () => {
    expect(stableKey({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(stableKey({ b: [1, { x: 1, y: 2 }], a: 1 }));
    expect(same({ a: 1, c: undefined }, { a: 1 })).toBe(true);
  });

  it('finds local edits, additions and deletions', () => {
    const base = { a: n('a', 'A'), b: n('b', 'B') };
    const local = { a: n('a', 'A2', 2), c: n('c', 'C') };
    expect([...pendingChanges(local, base)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('applies remote changes that do not conflict', () => {
    const base: Record<string, N> = { a: n('a', 'A'), b: n('b', 'B') };
    const snap = { ...base };
    const pending = pendingChanges(snap, base);
    const patches = mergeRemote([row('a', n('a', 'A remote', 5)), row('b', null), row('c', n('c', 'C'))], snap, base, pending, isN);
    expect(patches.get('a')?.title).toBe('A remote');
    expect(patches.get('b')).toBeNull();
    expect(patches.get('c')?.title).toBe('C');
    expect(Object.keys(base).sort()).toEqual(['a', 'c']);
  });

  it('ignores echoes of what is already known', () => {
    const base: Record<string, N> = { a: n('a', 'A') };
    const patches = mergeRemote([row('a', { updatedAt: 1, title: 'A', id: 'a' })], { ...base }, base, new Set(), isN);
    expect(patches.size).toBe(0);
  });

  it('resolves conflicts: newer wins, edits beat deletions', () => {
    const base: Record<string, N> = { a: n('a', 'A'), b: n('b', 'B'), c: n('c', 'C') };
    const snap: Record<string, N> = { a: n('a', 'A local', 10), c: n('c', 'C local', 3) }; // b deleted locally
    const pending = pendingChanges(snap, base);
    const patches = mergeRemote(
      [row('a', n('a', 'A remote', 5)), row('b', n('b', 'B remote', 4)), row('c', null)],
      snap,
      base,
      pending,
      isN,
    );
    expect(patches.has('a')).toBe(false); // local is newer → stays pending, will be pushed
    expect(pending.has('a')).toBe(true);
    expect(patches.get('b')?.title).toBe('B remote'); // remote edit restores the locally deleted page
    expect(pending.has('b')).toBe(false);
    expect(patches.has('c')).toBe(false); // local edit survives remote deletion
    expect(pending.has('c')).toBe(true);
  });

  it('does not overwrite edits made while syncing', () => {
    const snap = { a: n('a', 'A'), b: n('b', 'B') };
    const current = { a: n('a', 'A typed meanwhile', 9), b: snap.b };
    const out = applyPatches(current, snap, new Map([['a', n('a', 'A remote')], ['b', n('b', 'B remote')]]))!;
    expect(out.a.title).toBe('A typed meanwhile');
    expect(out.b.title).toBe('B remote');
  });
});
