import { describe, expect, it } from 'vitest';
import { buildTree, InputError, planAddKnowledge, renderOutline, type LightNode } from './logic.ts';

const existing: LightNode[] = [
  { id: 'n_ml', title: 'Machine Learning', parentId: null, order: 1 },
  { id: 'n_dl', title: 'Deep Learning', parentId: 'n_ml', order: 1 },
  { id: 'n_att', title: 'Attention', parentId: 'n_dl', order: 1 },
  { id: 'n_math', title: 'Mathematics', parentId: null, order: 2 },
  { id: 'n_mat', title: 'Matrices', parentId: 'n_math', order: 1 },
];

describe('MCP connector logic', () => {
  it('renders an outline with ids and depth limits', () => {
    const out = renderOutline(buildTree(existing), null, 2);
    expect(out).toContain('- [n_ml] Machine Learning');
    expect(out).toContain('  - [n_dl] Deep Learning  (+1 nested pages not shown)');
    expect(renderOutline(buildTree(existing), 'n_dl', 5)).toBe('- [n_dl] Deep Learning\n  - [n_att] Attention');
  });

  it('places pages by id, ref or title and orders them after siblings', () => {
    const plan = planAddKnowledge(
      existing,
      [],
      [
        { ref: 't', title: 'Transformers', parent: 'Deep Learning', content: 'Built on attention.' },
        { ref: 'mha', title: 'Multi-Head Attention', parent: 't', content: 'Several heads.', tags: ['#nlp'] },
        { title: 'Optics', parent: '' },
      ],
      [
        { source: 'mha', target: 'Matrices', label: 'Uses' },
        { source: 't', target: 'n_att', label: 'built on' },
        { source: 't', target: 'Nowhere', label: 'x' },
      ],
    );
    const byTitle = Object.fromEntries(plan.create.map((n) => [n.title, n]));
    expect(byTitle.Transformers.parentId).toBe('n_dl');
    expect(byTitle.Transformers.order).toBe(2);
    expect(byTitle['Multi-Head Attention'].parentId).toBe(byTitle.Transformers.id);
    expect(byTitle['Multi-Head Attention'].tags).toEqual(['nlp']);
    expect(byTitle.Optics.parentId).toBeNull();
    expect(byTitle.Optics.order).toBe(3);
    expect(plan.links.map((l) => [l.source, l.target, l.label])).toEqual([
      [byTitle['Multi-Head Attention'].id, 'n_mat', 'uses'],
      [byTitle.Transformers.id, 'n_att', 'built on'],
    ]);
    expect(plan.notes.some((n) => n.includes('Nowhere'))).toBe(true);
    expect(plan.refMap.t).toBe(byTitle.Transformers.id);
  });

  it('merges into an existing sibling with the same title instead of duplicating', () => {
    const plan = planAddKnowledge(existing, [], [
      { ref: 'a', title: 'attention', parent: 'n_dl', content: 'Scaled dot-product.' },
      { title: 'Self-Attention', parent: 'a', content: 'Q, K, V from the same sequence.' },
    ], []);
    expect(plan.append).toEqual([{ id: 'n_att', content: 'Scaled dot-product.', tags: [], sources: [] }]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].parentId).toBe('n_att'); // child of the merged page lands under the existing one
    expect(plan.refMap.a).toBe('n_att');
  });

  it('rejects bad input without writing anything', () => {
    expect(() => planAddKnowledge(existing, [], [{ title: 'X', parent: 'Missing Parent' }], [])).toThrow(InputError);
    expect(() => planAddKnowledge(existing, [], [{ ref: 'a', title: 'A', parent: 'b' }, { ref: 'b', title: 'B', parent: 'a' }], [])).toThrow(/cycle/);
  });

  it('skips relations that already exist', () => {
    const plan = planAddKnowledge(existing, [{ source: 'n_att', target: 'n_mat', label: 'uses' }], [], [{ source: 'Attention', target: 'Matrices', label: 'Uses' }]);
    expect(plan.links).toHaveLength(0);
  });
});
