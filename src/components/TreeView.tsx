import { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';
import { getIndex, useStore } from '../store/store';
import { childrenOf, implicitLinks, nodeColor, truncate } from '../lib/tree';
import { openNodeMenu } from './ContextMenu';

interface TDatum {
  id: string;
  title: string;
  icon?: string;
  color: string;
  count: number;
  open: boolean;
  children?: TDatum[];
}

const VROOT = '__vroot__';
const ROW = 30;
const COL = 210;

function fitTree(svgEl: SVGSVGElement, zoom: d3.ZoomBehavior<SVGSVGElement, unknown>, nodes: d3.HierarchyPointNode<TDatum>[], animate: boolean) {
  const { width, height } = svgEl.getBoundingClientRect();
  if (!nodes.length || !width) return;
  const xs = nodes.map((n) => n.y);
  const ys = nodes.map((n) => n.x);
  const x0 = Math.min(...xs) - 30;
  const x1 = Math.max(...xs) + 240;
  const y0 = Math.min(...ys) - 40;
  const y1 = Math.max(...ys) + 40;
  const k = Math.max(0.2, Math.min(1.15, Math.min(width / (x1 - x0), height / (y1 - y0))));
  const t = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(k)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  const sel = d3.select(svgEl);
  if (animate) sel.transition().duration(500).call(zoom.transform, t);
  else sel.call(zoom.transform, t);
}

/** Left-to-right mind map of the hierarchy, sharing expand state with the graph. */
export function TreeView() {
  const data = useStore((s) => s.data);
  const expanded = useStore((s) => s.expanded);
  const focusId = useStore((s) => s.focusId);
  const selectedId = useStore((s) => s.selectedId);
  const showLinks = useStore((s) => s.showLinks);
  const flash = useStore((s) => s.flash);
  const centerRequest = useStore((s) => s.centerRequest);
  const index = getIndex(data.nodes);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const firstRef = useRef(true);
  const handledNonce = useRef(0);

  const layout = useMemo(() => {
    const build = (id: string): TDatum => {
      const n = data.nodes[id];
      const kids = childrenOf(index, id);
      const open = kids.length > 0 && (!!expanded[id] || id === focusId);
      return {
        id,
        title: n.title,
        icon: n.icon,
        color: nodeColor(data.nodes, index, id),
        count: index.descCount.get(id) ?? 0,
        open,
        children: open ? kids.map(build) : undefined,
      };
    };
    const tops = focusId && data.nodes[focusId] ? [focusId] : index.roots;
    const tree: TDatum = { id: VROOT, title: '', color: '#888', count: 0, open: true, children: tops.map(build) };
    const h = d3.hierarchy(tree);
    return d3.tree<TDatum>().nodeSize([ROW, COL]).separation((a, b) => (a.parent === b.parent ? 1 : 1.4))(h);
  }, [data.nodes, index, expanded, focusId]);

  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    if (svg.select('g.viewport').empty()) {
      const vp = svg.append('g').attr('class', 'viewport');
      vp.append('g').attr('class', 'tree-links');
      vp.append('g').attr('class', 'tree-cross');
      vp.append('g').attr('class', 'tree-nodes');
      const zoom = d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 3])
        .on('zoom', (ev) => vp.attr('transform', ev.transform.toString()));
      zoomRef.current = zoom;
      svg.call(zoom).on('dblclick.zoom', null);
      svg.on('click', (ev: MouseEvent) => {
        if (ev.target === svgRef.current) useStore.getState().select(null);
      });
    }
    const vp = svg.select<SVGGElement>('g.viewport');
    const nodes = layout.descendants().filter((d) => d.data.id !== VROOT);
    const linksData = layout.links().filter((l) => l.source.data.id !== VROOT);
    const byId = new Map(nodes.map((n) => [n.data.id, n]));

    const link = d3
      .linkHorizontal<d3.HierarchyPointLink<TDatum>, d3.HierarchyPointNode<TDatum>>()
      .x((d) => d.y)
      .y((d) => d.x);
    vp.select('.tree-links')
      .selectAll<SVGPathElement, d3.HierarchyPointLink<TDatum>>('path')
      .data(linksData, (l) => `${l.source.data.id}>${l.target.data.id}`)
      .join('path')
      .attr('class', 'tree-link')
      .style('stroke', (l) => l.target.data.color)
      .transition()
      .duration(300)
      .attr('d', link);

    const cross: { s: d3.HierarchyPointNode<TDatum>; t: d3.HierarchyPointNode<TDatum>; key: string; label: string }[] = [];
    if (showLinks) {
      const all = [
        ...Object.values(data.links).map((l) => ({ s: l.source, t: l.target, label: l.label })),
        ...implicitLinks(data.nodes).map((l) => ({ s: l.source, t: l.target, label: 'mentions' })),
      ];
      for (const l of all) {
        const s = byId.get(l.s);
        const t = byId.get(l.t);
        if (s && t) cross.push({ s, t, key: `${l.s}>${l.t}>${l.label}`, label: l.label });
      }
    }
    vp.select('.tree-cross')
      .selectAll<SVGPathElement, (typeof cross)[number]>('path')
      .data(cross, (c) => c.key)
      .join((e) => e.append('path').call((p) => p.append('title')))
      .attr('class', 'tree-crosslink')
      .attr('d', (c) => {
        const sx = c.s.y + 8;
        const sy = c.s.x;
        const tx = c.t.y + 8;
        const ty = c.t.x;
        const bend = Math.max(60, Math.abs(ty - sy) * 0.35);
        return `M${sx},${sy}C${sx + bend},${sy} ${tx + bend},${ty} ${tx},${ty}`;
      })
      .select('title')
      .text((c) => `${c.s.data.title} — ${c.label || 'related'} → ${c.t.data.title}`);

    const g = vp
      .select('.tree-nodes')
      .selectAll<SVGGElement, d3.HierarchyPointNode<TDatum>>('g.tnode')
      .data(nodes, (d) => d.data.id)
      .join((enter) => {
        const e = enter.append('g').attr('class', 'tnode');
        e.attr('transform', (d) => {
          const p = d.parent && d.parent.data.id !== VROOT ? d.parent : d;
          return `translate(${p.y},${p.x})`;
        });
        e.append('rect').attr('class', 'tnode-bg');
        e.append('circle').attr('class', 'tnode-dot');
        e.append('text').attr('class', 'tnode-label').attr('dy', '0.35em').attr('x', 14);
        e.append('text').attr('class', 'tnode-count').attr('dy', '0.35em');
        return e;
      });
    g.transition()
      .duration(300)
      .attr('transform', (d) => `translate(${d.y},${d.x})`);
    g.select<SVGCircleElement>('circle.tnode-dot')
      .attr('r', (d) => (d.data.count ? 7 : 5))
      .style('fill', (d) => (d.data.count && !d.data.open ? d.data.color : 'var(--bg)'))
      .style('stroke', (d) => d.data.color);
    g.select<SVGTextElement>('text.tnode-label')
      .text((d) => truncate(`${d.data.icon ? d.data.icon + ' ' : ''}${d.data.title}`, 30))
      .classed('branch', (d) => d.data.count > 0);
    g.select<SVGTextElement>('text.tnode-count')
      .attr('x', function () {
        const lbl = (this.parentNode as SVGGElement).querySelector('text.tnode-label') as SVGTextElement | null;
        let w = 0;
        try {
          w = lbl?.getComputedTextLength() ?? 0;
        } catch {
          w = 0;
        }
        return 20 + w;
      })
      .text((d) => (d.data.count && !d.data.open ? `+${d.data.count}` : ''));
    g.select<SVGRectElement>('rect.tnode-bg')
      .attr('x', -10)
      .attr('y', -12)
      .attr('height', 24)
      .attr('rx', 6)
      .attr('width', function () {
        const lbl = (this.parentNode as SVGGElement).querySelector('text.tnode-label') as SVGTextElement | null;
        let w = 0;
        try {
          w = lbl?.getComputedTextLength() ?? 0;
        } catch {
          w = 0;
        }
        return w + 60;
      });

    g.on('click', (ev: MouseEvent, d) => {
      ev.stopPropagation();
      const st = useStore.getState();
      const onDot = (ev.target as Element).classList.contains('tnode-dot');
      if (onDot && d.data.count) st.toggleExpanded(d.data.id);
      else st.select(d.data.id);
    })
      .on('dblclick', (ev: MouseEvent, d) => {
        ev.stopPropagation();
        if (d.data.count && d.data.id !== useStore.getState().focusId) useStore.getState().toggleExpanded(d.data.id);
      })
      .on('contextmenu', (ev: MouseEvent, d) => {
        ev.preventDefault();
        useStore.getState().select(d.data.id);
        openNodeMenu(d.data.id, ev.clientX, ev.clientY);
      });

    if (firstRef.current && zoomRef.current) {
      firstRef.current = false;
      fitTree(svgRef.current!, zoomRef.current, nodes, false);
    }
  }, [layout, data, showLinks]);

  useEffect(() => {
    d3.select(svgRef.current!)
      .selectAll<SVGGElement, d3.HierarchyPointNode<TDatum>>('g.tnode')
      .classed('selected', (d) => d.data.id === selectedId)
      .classed('flash', (d) => !!flash[d.data.id]);
  }, [selectedId, flash, layout]);

  // centre on request / fit
  useEffect(() => {
    const centre = (id: string | null) => {
      const svgEl = svgRef.current;
      if (!svgEl || !zoomRef.current) return;
      const { width, height } = svgEl.getBoundingClientRect();
      const nodes = layout.descendants().filter((d) => d.data.id !== VROOT);
      if (!nodes.length) return;
      if (id) {
        const n = nodes.find((d) => d.data.id === id);
        if (!n) return;
        d3.select(svgEl)
          .transition()
          .duration(500)
          .call(zoomRef.current.transform, d3.zoomIdentity.translate(width / 2 - n.y, height / 2 - n.x));
        return;
      }
      fitTree(svgEl, zoomRef.current, nodes, true);
    };
    const onFit = () => centre(null);
    window.addEventListener('kg:fit', onFit);
    let t: number | undefined;
    if (centerRequest && centerRequest.nonce !== handledNonce.current) {
      handledNonce.current = centerRequest.nonce;
      t = window.setTimeout(() => centre(centerRequest.id), 350);
    }
    return () => {
      window.removeEventListener('kg:fit', onFit);
      window.clearTimeout(t);
    };
  }, [centerRequest, layout]);

  return (
    <div className="tree-wrap">
      <svg ref={svgRef} className="tree-svg" role="img" aria-label="Mind map of the hierarchy" />
    </div>
  );
}
