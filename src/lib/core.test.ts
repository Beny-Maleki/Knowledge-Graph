import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import type { GraphData, Proposal } from '../types';
import { ancestors, buildIndex, childrenOf, descendants, makeNode, makeLink, wikiTargets, titleSimilarity } from './tree';
import { addLink, applyProposal, applyPruneOps, deleteNode, mergeNodes, moveNode, sanitizeData } from './ops';
import { parseOutline } from './outline';
import { normalizeProposal, serializeOutline } from './pipeline';
import { exportMarkdownZip, markdownFilesToGraph } from './interchange';
import { analyze } from './health';

/** a ─ b ─ d
 *    └ c
 *  e            (second root) */
function fixture(): GraphData {
  const a = makeNode({ id: 'a', title: 'Alpha', order: 1 });
  const b = makeNode({ id: 'b', title: 'Beta', parentId: 'a', order: 1 });
  const c = makeNode({ id: 'c', title: 'Gamma', parentId: 'a', order: 2 });
  const d = makeNode({ id: 'd', title: 'Delta', parentId: 'b', order: 1, content: 'about delta' });
  const e = makeNode({ id: 'e', title: 'Epsilon', order: 2 });
  const l = makeLink('d', 'e', 'uses');
  return { nodes: { a, b, c, d, e }, links: { [l.id]: l } };
}

describe('tree index', () => {
  it('builds children, depth and descendant counts', () => {
    const g = fixture();
    const idx = buildIndex(g.nodes);
    expect(idx.roots).toEqual(['a', 'e']);
    expect(childrenOf(idx, 'a')).toEqual(['b', 'c']);
    expect(idx.descCount.get('a')).toBe(3);
    expect(idx.depth.get('d')).toBe(2);
    expect(ancestors(g.nodes, 'd')).toEqual(['a', 'b']);
    expect(descendants(idx, 'a').sort()).toEqual(['b', 'c', 'd']);
  });

  it('surfaces nodes caught in a parent cycle as roots', () => {
    const x = makeNode({ id: 'x', title: 'X', parentId: 'y' });
    const y = makeNode({ id: 'y', title: 'Y', parentId: 'x' });
    const idx = buildIndex({ x, y });
    expect(idx.roots.length).toBeGreaterThan(0);
    expect(idx.depth.size).toBe(2);
  });
});

describe('graph operations', () => {
  it('deletes a subtree and its links', () => {
    const g = deleteNode(fixture(), 'b', 'subtree');
    expect(Object.keys(g.nodes).sort()).toEqual(['a', 'c', 'e']);
    expect(Object.keys(g.links)).toHaveLength(0);
  });

  it('lifts children into the deleted node’s slot', () => {
    const g = deleteNode(fixture(), 'b', 'lift');
    expect(g.nodes.d.parentId).toBe('a');
    expect(childrenOf(buildIndex(g.nodes), 'a')).toEqual(['d', 'c']);
    expect(Object.keys(g.links)).toHaveLength(1);
  });

  it('moves nodes, keeps order and refuses cycles', () => {
    const g0 = fixture();
    expect(moveNode(g0, 'a', 'd')).toBe(g0);
    const g = moveNode(g0, 'c', 'a', 'b');
    expect(childrenOf(buildIndex(g.nodes), 'a')).toEqual(['c', 'b']);
    const g2 = moveNode(g, 'e', 'b');
    expect(g2.nodes.e.parentId).toBe('b');
  });

  it('merges content, children and links', () => {
    let g = fixture();
    g = addLink(g, 'c', 'b', 'related').data;
    g = mergeNodes(g, 'b', 'c');
    expect(g.nodes.b).toBeUndefined();
    expect(g.nodes.d.parentId).toBe('c');
    // the c→b link would become a self-link and is dropped
    expect(Object.values(g.links).every((l) => l.source !== l.target)).toBe(true);
  });

  it('applies a proposal with refs, merges and links', () => {
    const p: Proposal = {
      summary: '',
      sources: ['book'],
      nodes: [
        { ref: 'r1', title: 'New Group', parent: 'a', content: 'g', tags: [], mergeInto: null, accepted: true },
        { ref: 'r2', title: 'Child', parent: 'r1', content: 'c', tags: ['t'], mergeInto: null, accepted: true },
        { ref: 'r3', title: 'Delta', parent: 'b', content: 'more about delta', tags: [], mergeInto: 'd', accepted: true },
        { ref: 'r4', title: 'Skipped', parent: 'a', content: '', tags: [], mergeInto: null, accepted: false },
      ],
      links: [
        { source: 'r2', target: 'e', label: 'depends on', accepted: true },
        { source: 'r3', target: 'r1', label: 'part of', accepted: true },
      ],
    };
    const r = applyProposal(fixture(), p);
    expect(r.created).toHaveLength(2);
    expect(r.updated).toEqual(['d']);
    const group = Object.values(r.data.nodes).find((n) => n.title === 'New Group')!;
    const child = Object.values(r.data.nodes).find((n) => n.title === 'Child')!;
    expect(group.parentId).toBe('a');
    expect(child.parentId).toBe(group.id);
    expect(child.sources).toEqual(['book']);
    expect(r.data.nodes.d.content).toContain('more about delta');
    expect(r.linksAdded).toBe(2);
    expect(Object.values(r.data.nodes).some((n) => n.title === 'Skipped')).toBe(false);
  });

  it('applies prune ops including groups', () => {
    const g = applyPruneOps(fixture(), [
      { kind: 'group', node: 'a', target: 'Greek', members: ['b', 'c'], reason: '', accepted: true },
      { kind: 'rename', node: 'e', target: 'Epsilon!', reason: '', accepted: true },
      { kind: 'delete', node: 'a', target: '', reason: '', accepted: false },
    ]);
    expect(g.applied).toBe(2);
    const grp = g.data.nodes[g.createdGroups[0]];
    expect(grp.parentId).toBe('a');
    expect(g.data.nodes.b.parentId).toBe(grp.id);
    expect(g.data.nodes.e.title).toBe('Epsilon!');
  });

  it('sanitises broken data', () => {
    const g = sanitizeData({ nodes: { x: { id: 'x', parentId: 'missing' } }, links: { l: { id: 'l', source: 'x', target: 'nope' } } });
    expect(g.nodes.x.parentId).toBeNull();
    expect(g.nodes.x.title).toBe('Untitled');
    expect(Object.keys(g.links)).toHaveLength(0);
  });
});

describe('outline parser', () => {
  it('turns headings and bullets into a hierarchy', () => {
    const p = parseOutline('# Topic\nIntro text.\n## Sub\n- Term: definition here\n  - Nested item\n- Other\n', {
      bulletsAsNodes: true,
      parent: 'a',
      wrapTitle: null,
      source: 'notes.md',
    });
    const byTitle = Object.fromEntries(p.nodes.map((n) => [n.title, n]));
    expect(byTitle.Topic.parent).toBe('a');
    expect(byTitle.Topic.content).toBe('Intro text.');
    expect(byTitle.Sub.parent).toBe(byTitle.Topic.ref);
    expect(byTitle.Term.content).toBe('definition here');
    expect(byTitle['Nested item'].parent).toBe(byTitle.Term.ref);
    expect(byTitle.Other.parent).toBe(byTitle.Sub.ref);
  });

  it('keeps lists as content when asked', () => {
    const p = parseOutline('# A\n- x\n- y\n', { bulletsAsNodes: false, parent: null, wrapTitle: null, source: '' });
    expect(p.nodes).toHaveLength(1);
    expect(p.nodes[0].content).toContain('- x');
  });

  it('parses an indented plain-text outline', () => {
    const p = parseOutline('Biology\n  Cells\n    Mitochondria\n  Genetics\n', { bulletsAsNodes: true, parent: null, wrapTitle: null, source: '' });
    const byTitle = Object.fromEntries(p.nodes.map((n) => [n.title, n]));
    expect(byTitle.Mitochondria.parent).toBe(byTitle.Cells.ref);
    expect(byTitle.Genetics.parent).toBe(byTitle.Biology.ref);
  });
});

describe('AI proposal normalisation', () => {
  it('resolves titles, keeps scope and merges duplicates', () => {
    const g = fixture();
    const p = normalizeProposal(
      {
        summary: 's',
        nodes: [
          { ref: 'r1', title: 'Zeta', parent: 'Beta', merge_into: '', content: 'z', tags: ['#greek'] },
          { ref: 'r2', title: 'Gamma', parent: 'a', merge_into: '', content: 'extra', tags: [] },
          { ref: 'r3', title: 'Outside', parent: 'e', merge_into: '', content: '', tags: [] },
          { ref: 'r4', title: '', parent: 'a', merge_into: '', content: '', tags: [] },
        ],
        links: [
          { source: 'r1', target: 'Epsilon', label: 'Relates To' },
          { source: 'r1', target: 'b', label: 'child of' },
          { source: 'r1', target: 'missing', label: 'x' },
        ],
      },
      g,
      { defaultParent: 'a', scope: 'a', sources: [] },
    );
    const byRef = Object.fromEntries(p.nodes.map((n) => [n.ref, n]));
    expect(p.nodes).toHaveLength(3);
    expect(byRef.r1.parent).toBe('b');
    expect(byRef.r1.tags).toEqual(['greek']);
    expect(byRef.r2.mergeInto).toBe('c');
    expect(byRef.r3.parent).toBe('a'); // pulled back into scope
    expect(p.links).toEqual([{ source: 'r1', target: 'e', label: 'relates to', accepted: true }]);
  });

  it('serialises an outline with ids', () => {
    const out = serializeOutline(fixture());
    expect(out).toContain('- [a] Alpha');
    expect(out).toContain('    - [d] Delta');
  });
});

describe('markdown interchange', () => {
  it('round-trips hierarchy and labelled relations through a vault export', () => {
    const zip = exportMarkdownZip(fixture(), 'Vault');
    const files = Object.entries(unzipSync(zip)).map(([path, bytes]) => ({ path, text: strFromU8(bytes) }));
    expect(files.some((f) => f.path === 'Vault/Alpha/Beta/Delta.md')).toBe(true);
    const g = markdownFilesToGraph(files);
    const byTitle = Object.fromEntries(Object.values(g.nodes).map((n) => [n.title, n]));
    expect(Object.keys(byTitle).sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
    expect(byTitle.Delta.parentId).toBe(byTitle.Beta.id);
    expect(byTitle.Delta.content).toBe('about delta');
    const links = Object.values(g.links);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ source: byTitle.Delta.id, target: byTitle.Epsilon.id, label: 'uses' });
  });

  it('understands Notion exports', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const g = markdownFilesToGraph([
      { path: `Export/Physics ${id}.md`, text: '# Physics\n\nSee [Optics](Physics%20' + id + '/Optics%20' + id + '.md)' },
      { path: `Export/Physics ${id}/Optics ${id}.md`, text: '# Optics\n\nLight.' },
    ]);
    const byTitle = Object.fromEntries(Object.values(g.nodes).map((n) => [n.title, n]));
    expect(byTitle.Optics.parentId).toBe(byTitle.Physics.id);
    expect(byTitle.Physics.content).toContain('[[Optics]]');
    expect(Object.keys(g.nodes)).toHaveLength(2);
  });
});

describe('health & helpers', () => {
  it('ignores wiki links inside code', () => {
    expect(wikiTargets('a [[X]] `[[Y]]` ```\n[[Z]]\n```')).toEqual(['X']);
  });

  it('finds duplicates, stubs and broken links', () => {
    const g = fixture();
    g.nodes.f = makeNode({ id: 'f', title: 'Deltas', parentId: 'e', content: 'see [[Nowhere]]' });
    const kinds = analyze(g).map((i) => i.kind);
    expect(kinds).toContain('duplicate');
    expect(kinds).toContain('stub');
    expect(kinds).toContain('broken');
    expect(titleSimilarity('Neural Network', 'neural networks')).toBeGreaterThan(0.9);
  });
});
