import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { getIndex, useStore } from '../store/store';
import { childrenOf, descendants, excerpt, implicitLinks, nodeColor, pathTitles, type TreeIndex } from '../lib/tree';
import type { GraphData } from '../types';
import { safeLocalGet, safeLocalSet } from '../store/persist';
import { openNodeMenu } from './ContextMenu';

interface VNode extends d3.SimulationNodeDatum {
  id: string;
  title: string;
  icon?: string;
  color: string;
  r: number;
  group: boolean;
  expanded: boolean;
  count: number;
  depth: number;
  vparent: string | null;
}

interface VEdge extends d3.SimulationLinkDatum<VNode> {
  key: string;
  kind: 'tree' | 'link' | 'agg' | 'mention';
  label: string;
  count: number;
}

interface Hull {
  id: string;
  members: string[];
  pad: number;
  color: string;
}

interface Model {
  nodes: VNode[];
  tree: VEdge[];
  cross: VEdge[];
  hulls: Hull[];
  signature: string;
}

const POS_KEY = 'kg:pos:v1';
/** Positions survive view switches and reloads so the mental map stays stable. */
const posCache: Map<string, { x: number; y: number }> = new Map(Object.entries(safeLocalGet<Record<string, { x: number; y: number }>>(POS_KEY) ?? {}));
let posSaveTimer: number | undefined;
function savePositions() {
  window.clearTimeout(posSaveTimer);
  posSaveTimer = window.setTimeout(() => {
    const obj: Record<string, { x: number; y: number }> = {};
    for (const [k, v] of posCache) obj[k] = { x: Math.round(v.x), y: Math.round(v.y) };
    safeLocalSet(POS_KEY, obj);
  }, 800);
}

function radius(group: boolean, expanded: boolean, count: number) {
  if (!group) return 7;
  if (expanded) return 11 + Math.min(8, Math.sqrt(count));
  return 12 + 3.2 * Math.sqrt(count);
}

function buildModel(data: GraphData, index: TreeIndex, expanded: Record<string, true>, focusId: string | null, showLinks: boolean): Model {
  const nodes: VNode[] = [];
  const tree: VEdge[] = [];
  const hulls: Hull[] = [];
  const rep = new Map<string, string>();
  const tops = focusId && data.nodes[focusId] ? [focusId] : index.roots;

  const walk = (id: string, depth: number, vparent: string | null): { members: string[]; height: number } => {
    const n = data.nodes[id];
    const kids = childrenOf(index, id);
    const count = index.descCount.get(id) ?? 0;
    const isExp = kids.length > 0 && (!!expanded[id] || id === focusId);
    nodes.push({
      id,
      title: n.title,
      icon: n.icon,
      color: nodeColor(data.nodes, index, id),
      r: radius(kids.length > 0, isExp, count),
      group: kids.length > 0,
      expanded: isExp,
      count,
      depth,
      vparent,
    });
    rep.set(id, id);
    if (vparent) tree.push({ key: `t:${vparent}>${id}`, source: vparent, target: id, kind: 'tree', label: '', count: 1 });
    if (!isExp) {
      for (const d of descendants(index, id)) rep.set(d, id);
      return { members: [id], height: 0 };
    }
    const members = [id];
    let height = 0;
    for (const k of kids) {
      const r = walk(k, depth + 1, id);
      members.push(...r.members);
      height = Math.max(height, r.height);
    }
    hulls.push({ id, members, pad: 14 + 13 * height, color: nodeColor(data.nodes, index, id) });
    return { members, height: height + 1 };
  };
  for (const t of tops) walk(t, 0, null);

  const cross: VEdge[] = [];
  if (showLinks) {
    const byKey = new Map<string, VEdge>();
    const explicitPairs = new Set<string>();
    for (const l of Object.values(data.links)) {
      const a = rep.get(l.source);
      const b = rep.get(l.target);
      if (!a || !b || a === b) continue;
      const direct = a === l.source && b === l.target;
      explicitPairs.add(`${l.source}|${l.target}`);
      explicitPairs.add(`${l.target}|${l.source}`);
      const key = direct ? `d:${a}>${b}` : `a:${a < b ? a + '|' + b : b + '|' + a}`;
      const e = byKey.get(key);
      if (e) {
        e.count++;
        if (direct && l.label && !e.label.split(', ').includes(l.label)) e.label = e.label ? `${e.label}, ${l.label}` : l.label;
      } else byKey.set(key, { key, source: a, target: b, kind: direct ? 'link' : 'agg', label: direct ? l.label : '', count: 1 });
    }
    for (const l of implicitLinks(data.nodes)) {
      if (explicitPairs.has(`${l.source}|${l.target}`)) continue;
      const a = rep.get(l.source);
      const b = rep.get(l.target);
      if (!a || !b || a === b) continue;
      const direct = a === l.source && b === l.target;
      const key = direct ? `m:${a}>${b}` : `a:${a < b ? a + '|' + b : b + '|' + a}`;
      const e = byKey.get(key);
      if (e) e.count++;
      else byKey.set(key, { key, source: a, target: b, kind: direct ? 'mention' : 'agg', label: '', count: 1 });
    }
    cross.push(...byKey.values());
  }
  const signature = nodes.map((n) => `${n.id}${n.expanded ? '+' : ''}`).join(',') + '#' + cross.map((e) => e.key).join(',');
  return { nodes, tree, cross, hulls, signature };
}

function hullPath(h: Hull, byId: Map<string, VNode>): string {
  const pts: [number, number][] = [];
  for (const m of h.members) {
    const n = byId.get(m);
    if (!n || n.x == null || n.y == null) continue;
    const rr = n.r + h.pad;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      pts.push([n.x + Math.cos(a) * rr, n.y + Math.sin(a) * rr]);
    }
  }
  if (pts.length < 3) return '';
  const hull = d3.polygonHull(pts);
  if (!hull) return '';
  return d3.line().curve(d3.curveCatmullRomClosed.alpha(0.6))(hull) ?? '';
}

export function GraphView() {
  const data = useStore((s) => s.data);
  const expanded = useStore((s) => s.expanded);
  const focusId = useStore((s) => s.focusId);
  const showLinks = useStore((s) => s.showLinks);
  const showHulls = useStore((s) => s.showHulls);
  const showLabels = useStore((s) => s.showLabels);
  const selectedId = useStore((s) => s.selectedId);
  const flash = useStore((s) => s.flash);
  const centerRequest = useStore((s) => s.centerRequest);

  const index = getIndex(data.nodes);
  const model = useMemo(() => buildModel(data, index, expanded, focusId, showLinks), [data, index, expanded, focusId, showLinks]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<VNode, VEdge> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const byIdRef = useRef<Map<string, VNode>>(new Map());
  const sigRef = useRef('');
  const modelRef = useRef(model);
  const kRef = useRef(1);
  const fitPending = useRef(true);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

  modelRef.current = model;

  // ---- one-time setup -------------------------------------------------------
  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    svg.selectAll('*').remove();
    const defs = svg.append('defs');
    defs
      .append('marker')
      .attr('id', 'kg-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10)
      .attr('refY', 0)
      .attr('markerWidth', 7)
      .attr('markerHeight', 7)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L10,0L0,4')
      .attr('class', 'arrow-head');
    const vp = svg.append('g').attr('class', 'viewport');
    vp.append('g').attr('class', 'hulls');
    vp.append('g').attr('class', 'tree-edges');
    vp.append('g').attr('class', 'cross-edges');
    vp.append('g').attr('class', 'edge-labels');
    vp.append('g').attr('class', 'nodes');
    vp.append('line').attr('class', 'link-draft').style('display', 'none');

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.08, 4])
      .on('zoom', (ev) => {
        vp.attr('transform', ev.transform.toString());
        kRef.current = ev.transform.k;
        svg.classed('lod-low', ev.transform.k < 0.55).classed('lod-mid', ev.transform.k >= 0.55 && ev.transform.k < 1.1);
        setHover(null);
      });
    zoomRef.current = zoom;
    svg.call(zoom).on('dblclick.zoom', null);
    const rect = svgRef.current!.getBoundingClientRect();
    svg.call(zoom.transform, d3.zoomIdentity.translate(rect.width / 2, rect.height / 2).scale(0.9));

    svg.on('click', (ev: MouseEvent) => {
      if (ev.target === svgRef.current) useStore.getState().select(null);
    });

    const sim = d3
      .forceSimulation<VNode, VEdge>()
      .alphaDecay(0.035)
      .velocityDecay(0.42)
      .on('tick', () => ticked())
      .on('end', () => {
        for (const n of modelRef.current.nodes) if (n.x != null && n.y != null) posCache.set(n.id, { x: n.x, y: n.y });
        savePositions();
      });
    simRef.current = sim;

    const onResize = () => {
      if (fitPending.current) fit(false);
    };
    window.addEventListener('resize', onResize);
    return () => {
      sim.stop();
      window.removeEventListener('resize', onResize);
      for (const n of modelRef.current.nodes) if (n.x != null && n.y != null) posCache.set(n.id, { x: n.x, y: n.y });
      savePositions();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ticked() {
    const svg = d3.select(svgRef.current!);
    const byId = byIdRef.current;
    const pos = (e: VEdge, end: 'source' | 'target') => e[end] as VNode;
    svg
      .select('.tree-edges')
      .selectAll<SVGLineElement, VEdge>('line')
      .attr('x1', (e) => pos(e, 'source').x!)
      .attr('y1', (e) => pos(e, 'source').y!)
      .attr('x2', (e) => pos(e, 'target').x!)
      .attr('y2', (e) => pos(e, 'target').y!);
    svg
      .select('.cross-edges')
      .selectAll<SVGPathElement, VEdge>('path')
      .attr('d', (e) => {
        const s = pos(e, 'source');
        const t = pos(e, 'target');
        const dx = t.x! - s.x!;
        const dy = t.y! - s.y!;
        const dist = Math.hypot(dx, dy) || 1;
        // trim to circle borders, bend slightly so links differ from tree edges
        const sx = s.x! + (dx / dist) * s.r;
        const sy = s.y! + (dy / dist) * s.r;
        const tx = t.x! - (dx / dist) * (t.r + 3);
        const ty = t.y! - (dy / dist) * (t.r + 3);
        const mx = (sx + tx) / 2 - (dy / dist) * dist * 0.12;
        const my = (sy + ty) / 2 + (dx / dist) * dist * 0.12;
        return `M${sx},${sy}Q${mx},${my} ${tx},${ty}`;
      });
    svg
      .select('.edge-labels')
      .selectAll<SVGTextElement, VEdge>('text')
      .attr('x', (e) => {
        const s = pos(e, 'source');
        const t = pos(e, 'target');
        const dy = t.y! - s.y!;
        const dist = Math.hypot(t.x! - s.x!, dy) || 1;
        return (s.x! + t.x!) / 2 - (dy / dist) * dist * 0.06;
      })
      .attr('y', (e) => {
        const s = pos(e, 'source');
        const t = pos(e, 'target');
        const dx = t.x! - s.x!;
        const dist = Math.hypot(dx, t.y! - s.y!) || 1;
        return (s.y! + t.y!) / 2 + (dx / dist) * dist * 0.06;
      });
    svg.select('.nodes').selectAll<SVGGElement, VNode>('g.node').attr('transform', (d) => `translate(${d.x},${d.y})`);
    svg
      .select('.hulls')
      .selectAll<SVGPathElement, Hull>('path')
      .attr('d', (h) => hullPath(h, byId));
  }

  function fit(animate = true) {
    const svgEl = svgRef.current;
    const zoom = zoomRef.current;
    const nodes = modelRef.current.nodes;
    if (!svgEl || !zoom || !nodes.length) return;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const pad = 80;
    const x0 = Math.min(...xs) - pad;
    const x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad;
    const y1 = Math.max(...ys) + pad;
    const { width, height } = svgEl.getBoundingClientRect();
    if (!width || !height) return;
    const k = Math.max(0.12, Math.min(1.6, Math.min(width / (x1 - x0), height / (y1 - y0))));
    const t = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    const sel = d3.select(svgEl);
    if (animate) sel.transition().duration(600).call(zoom.transform, t);
    else sel.call(zoom.transform, t);
  }

  // expose fit to the toolbar
  useEffect(() => {
    const onFit = () => fit(true);
    window.addEventListener('kg:fit', onFit);
    return () => window.removeEventListener('kg:fit', onFit);
  });

  // ---- data → DOM -------------------------------------------------------------
  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    const sim = simRef.current!;
    const prev = byIdRef.current;
    const byId = new Map<string, VNode>();
    const structural = model.signature !== sigRef.current;
    sigRef.current = model.signature;

    // carry over positions & velocities; spawn new nodes next to their parent
    let fresh = 0;
    for (const n of model.nodes) {
      const old = prev.get(n.id);
      if (old && old.x != null) {
        n.x = old.x;
        n.y = old.y;
        n.vx = old.vx;
        n.vy = old.vy;
        n.fx = old.fx;
        n.fy = old.fy;
      } else {
        const cached = posCache.get(n.id);
        const parent = n.vparent ? (byId.get(n.vparent) ?? prev.get(n.vparent)) : undefined;
        if (cached && (!parent || Math.hypot(cached.x - (parent.x ?? 0), cached.y - (parent.y ?? 0)) < 400)) {
          n.x = cached.x;
          n.y = cached.y;
        } else if (parent && parent.x != null) {
          const a = Math.random() * Math.PI * 2;
          n.x = parent.x + Math.cos(a) * (parent.r + 30);
          n.y = parent.y! + Math.sin(a) * (parent.r + 30);
          fresh++;
        } else {
          const a = Math.random() * Math.PI * 2;
          const rr = 60 + Math.random() * 200;
          n.x = Math.cos(a) * rr;
          n.y = Math.sin(a) * rr;
          fresh++;
        }
      }
      byId.set(n.id, n);
    }
    byIdRef.current = byId;

    // hulls
    svg
      .select('.hulls')
      .selectAll<SVGPathElement, Hull>('path')
      .data(showHulls ? model.hulls : [], (h) => h.id)
      .join('path')
      .attr('class', 'hull')
      .style('fill', (h) => h.color)
      .style('stroke', (h) => h.color);

    // tree edges
    svg
      .select('.tree-edges')
      .selectAll<SVGLineElement, VEdge>('line')
      .data(model.tree, (e) => e.key)
      .join('line')
      .attr('class', 'edge tree');

    // cross edges
    svg
      .select('.cross-edges')
      .selectAll<SVGPathElement, VEdge>('path')
      .data(model.cross, (e) => e.key)
      .join((enter) => enter.append('path').call((p) => p.append('title')))
      .attr('class', (e) => `edge cross ${e.kind}`)
      .attr('marker-end', (e) => (e.kind === 'link' || e.kind === 'mention' ? 'url(#kg-arrow)' : null))
      .style('stroke-width', (e) => (e.kind === 'agg' ? Math.min(6, 1 + Math.log2(e.count + 1)) : null))
      .select('title')
      .text((e) => {
        const s = byId.get(typeof e.source === 'string' ? e.source : (e.source as VNode).id)?.title;
        const t = byId.get(typeof e.target === 'string' ? e.target : (e.target as VNode).id)?.title;
        if (e.kind === 'agg') return `${e.count} link${e.count > 1 ? 's' : ''} between “${s}” and “${t}” (expand to see)`;
        if (e.kind === 'mention') return `“${s}” mentions “${t}”`;
        return `${s} —${e.label ? ` ${e.label} ` : ''}→ ${t}`;
      });

    svg
      .select('.edge-labels')
      .selectAll<SVGTextElement, VEdge>('text')
      .data(
        model.cross.filter((e) => e.kind === 'link' && e.label),
        (e) => e.key,
      )
      .join('text')
      .attr('class', 'edge-label')
      .attr('text-anchor', 'middle')
      .text((e) => e.label);

    // nodes
    const nodeSel = svg
      .select('.nodes')
      .selectAll<SVGGElement, VNode>('g.node')
      .data(model.nodes, (d) => d.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'node');
        g.append('circle').attr('class', 'halo');
        g.append('circle').attr('class', 'body');
        g.append('text').attr('class', 'glyph').attr('text-anchor', 'middle').attr('dy', '0.35em');
        g.append('text').attr('class', 'label').attr('text-anchor', 'middle');
        return g;
      });

    nodeSel
      .classed('group', (d) => d.group)
      .classed('collapsed', (d) => d.group && !d.expanded)
      .classed('expanded', (d) => d.expanded)
      .classed('leaf', (d) => !d.group)
      .classed('top', (d) => d.depth === 0);
    nodeSel
      .select<SVGCircleElement>('circle.halo')
      .attr('r', (d) => d.r + 4)
      .style('stroke', (d) => d.color);
    nodeSel
      .select<SVGCircleElement>('circle.body')
      .attr('r', (d) => d.r)
      .style('fill', (d) => d.color)
      .style('stroke', (d) => d.color);
    nodeSel
      .select<SVGTextElement>('text.glyph')
      .text((d) => (d.icon ? d.icon : d.group && !d.expanded && d.r >= 16 ? String(d.count) : ''))
      .style('font-size', (d) => `${Math.max(10, Math.min(26, d.r * 0.85))}px`);
    nodeSel
      .select<SVGTextElement>('text.label')
      .attr('y', (d) => d.r + 13)
      .text((d) => d.title)
      .style('font-size', (d) => (d.group ? `${Math.min(17, 11 + d.r / 7)}px` : null));

    // interactions
    let linkFrom: VNode | null = null;
    const draft = svg.select<SVGLineElement>('.link-draft');
    nodeSel
      .on('click', (ev: MouseEvent, d) => {
        ev.stopPropagation();
        useStore.getState().select(d.id);
      })
      .on('dblclick', (ev: MouseEvent, d) => {
        ev.stopPropagation();
        const st = useStore.getState();
        if (d.group) {
          if (d.id === st.focusId) return;
          st.toggleExpanded(d.id);
        } else st.select(d.id);
      })
      .on('contextmenu', (ev: MouseEvent, d) => {
        ev.preventDefault();
        useStore.getState().select(d.id);
        openNodeMenu(d.id, ev.clientX, ev.clientY);
      })
      .on('mouseenter', (ev: MouseEvent, d) => {
        highlight(d.id);
        const rect = wrapRef.current!.getBoundingClientRect();
        setHover({ id: d.id, x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      })
      .on('mouseleave', () => {
        highlight(null);
        setHover(null);
      })
      .call(
        d3
          .drag<SVGGElement, VNode>()
          .on('start', (ev, d) => {
            const se = ev.sourceEvent as MouseEvent;
            if (se?.shiftKey) {
              linkFrom = d;
              draft.style('display', null).attr('x1', d.x!).attr('y1', d.y!).attr('x2', d.x!).attr('y2', d.y!);
              return;
            }
            if (!ev.active) sim.alphaTarget(0.2).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (ev, d) => {
            if (linkFrom) {
              draft.attr('x2', ev.x).attr('y2', ev.y);
              return;
            }
            d.fx = ev.x;
            d.fy = ev.y;
            setHover(null);
          })
          .on('end', (ev, d) => {
            if (linkFrom) {
              draft.style('display', 'none');
              const target = model.nodes.find((n) => n !== linkFrom && Math.hypot(n.x! - ev.x, n.y! - ev.y) <= n.r + 8);
              if (target) {
                const st = useStore.getState();
                const id = st.addLink(linkFrom.id, target.id, '');
                if (id) st.toast(`Linked “${linkFrom.title}” → “${target.title}”. Add a label on the page.`, 'success');
              }
              linkFrom = null;
              return;
            }
            if (!ev.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
            posCache.set(d.id, { x: d.x!, y: d.y! });
          }),
      );

    // forces
    sim.nodes(model.nodes);
    sim.force(
      'tree',
      d3
        .forceLink<VNode, VEdge>(model.tree)
        .id((d) => d.id)
        .distance((e) => (e.source as VNode).r + (e.target as VNode).r + 46 + ((e.target as VNode).expanded ? 46 : 0))
        .strength(0.7),
    );
    sim.force(
      'cross',
      d3
        .forceLink<VNode, VEdge>(model.cross)
        .id((d) => d.id)
        .distance(150)
        .strength((e) => (e.kind === 'agg' ? 0.015 : 0.04)),
    );
    sim.force(
      'charge',
      d3
        .forceManyBody<VNode>()
        .strength((d) => -190 - d.r * d.r * 1.2)
        .distanceMax(900),
    );
    sim.force(
      'collide',
      // leave room for the label under each node
      d3.forceCollide<VNode>((d) => d.r + 12 + Math.min(d.group ? 34 : 26, d.title.length * 1.7)).strength(0.8),
    );
    sim.force('x', d3.forceX<VNode>(0).strength(0.045));
    sim.force('y', d3.forceY<VNode>(0).strength(0.045));

    if (structural) {
      if (fresh > 20 && fresh > model.nodes.length * 0.5) {
        sim.alpha(1);
        for (let i = 0; i < 160; i++) sim.tick();
      }
      sim.alpha(Math.max(sim.alpha(), fresh ? 0.6 : 0.3)).restart();
    } else {
      ticked();
    }
    ticked();

    if (fitPending.current) {
      fitPending.current = false;
      window.setTimeout(() => fit(true), fresh > 0 ? 700 : 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, showHulls]);

  // refit when the focus changes
  const lastFocus = useRef(focusId);
  useEffect(() => {
    if (lastFocus.current !== focusId) {
      lastFocus.current = focusId;
      window.setTimeout(() => fit(true), 650);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  // selection / flash styling
  useEffect(() => {
    d3.select(svgRef.current!)
      .select('.nodes')
      .selectAll<SVGGElement, VNode>('g.node')
      .classed('selected', (d) => d.id === selectedId)
      .classed('flash', (d) => !!flash[d.id]);
  }, [selectedId, flash, model]);

  useEffect(() => {
    d3.select(svgRef.current!).classed('no-labels', !showLabels);
  }, [showLabels]);

  // centre on request
  useEffect(() => {
    if (!centerRequest) return;
    const t = window.setTimeout(() => {
      const n = byIdRef.current.get(centerRequest.id);
      const svgEl = svgRef.current;
      if (!n || !svgEl || !zoomRef.current || n.x == null) return;
      const { width, height } = svgEl.getBoundingClientRect();
      const k = Math.max(kRef.current, 0.9);
      const tr = d3.zoomIdentity
        .translate(width / 2, height / 2)
        .scale(k)
        .translate(-n.x, -n.y!);
      d3.select(svgEl).transition().duration(650).call(zoomRef.current.transform, tr);
    }, 420);
    return () => window.clearTimeout(t);
  }, [centerRequest]);

  function highlight(id: string | null) {
    const svg = d3.select(svgRef.current!);
    if (!id) {
      svg.classed('hovering', false);
      svg.selectAll('.hl').classed('hl', false);
      return;
    }
    const m = modelRef.current;
    const keep = new Set<string>([id]);
    const endId = (x: string | number | VNode) => (typeof x === 'object' ? x.id : String(x));
    for (const e of [...m.tree, ...m.cross]) {
      const s = endId(e.source!);
      const t = endId(e.target!);
      if (s === id) keep.add(t);
      if (t === id) keep.add(s);
    }
    svg.classed('hovering', true);
    svg.selectAll<SVGGElement, VNode>('g.node').classed('hl', (d) => keep.has(d.id));
    svg
      .selectAll<SVGElement, VEdge>('.tree-edges line, .cross-edges path, .edge-labels text')
      .classed('hl', (e) => endId(e.source!) === id || endId(e.target!) === id);
  }

  const hoverNode = hover ? data.nodes[hover.id] : null;
  return (
    <div className="graph-wrap" ref={wrapRef}>
      <svg ref={svgRef} className="graph-svg" role="img" aria-label="Knowledge graph" />
      {hoverNode && hover && (
        <div className="graph-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="tip-path">{pathTitles(data.nodes, hover.id).slice(0, -1).join(' › ') || 'Top level'}</div>
          <div className="tip-title">
            {hoverNode.icon} {hoverNode.title}
          </div>
          {hoverNode.content && <div className="tip-body">{excerpt(hoverNode.content, 160)}</div>}
          {(index.descCount.get(hover.id) ?? 0) > 0 && (
            <div className="tip-meta">
              {index.descCount.get(hover.id)} nested · {expanded[hover.id] ? 'double-click to fold' : 'double-click to unfold'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
