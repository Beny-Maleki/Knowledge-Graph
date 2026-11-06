import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { getIndex, useStore } from '../store/store';
import { childrenOf, implicitLinks, nodeColor } from '../lib/tree';
import { openNodeMenu } from './ContextMenu';

interface Datum {
  id: string;
  title: string;
  icon?: string;
  color: string;
  children?: Datum[];
}

type PNode = d3.HierarchyCircularNode<Datum>;

const VROOT = '__vroot__';

/**
 * Zoomable circle packing: the hierarchy as nested bubbles. Clicking a bubble
 * zooms into it (and makes it the shared focus), revealing finer levels.
 */
export function MapView() {
  const data = useStore((s) => s.data);
  const focusId = useStore((s) => s.focusId);
  const selectedId = useStore((s) => s.selectedId);
  const showLinks = useStore((s) => s.showLinks);
  const flash = useStore((s) => s.flash);
  const index = getIndex(data.nodes);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const viewRef = useRef<[number, number, number] | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const root = useMemo(() => {
    const build = (id: string): Datum => {
      const n = data.nodes[id];
      const kids = childrenOf(index, id);
      return {
        id,
        title: n.title,
        icon: n.icon,
        color: nodeColor(data.nodes, index, id),
        children: kids.length ? kids.map(build) : undefined,
      };
    };
    const tree: Datum = { id: VROOT, title: 'All', color: '#888', children: index.roots.map(build) };
    const h = d3
      .hierarchy(tree)
      .sum((d) => (d.children ? 0 : 1))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const diameter = 1000;
    return d3.pack<Datum>().size([diameter, diameter]).padding((d) => (d.depth === 0 ? 30 : d.height > 1 ? 14 : 6))(h);
  }, [data.nodes, index]);

  const byId = useMemo(() => {
    const m = new Map<string, PNode>();
    root.each((n) => m.set(n.data.id, n));
    return m;
  }, [root]);

  const focusNode = (focusId && byId.get(focusId)) || root;
  const effFocusId = focusNode.data.id;

  const links = useMemo(() => {
    if (!showLinks) return [] as { s: string; t: string; label: string }[];
    const out = Object.values(data.links).map((l) => ({ s: l.source, t: l.target, label: l.label }));
    for (const l of implicitLinks(data.nodes)) out.push({ s: l.source, t: l.target, label: 'mentions' });
    return out;
  }, [data, showLinks]);

  // render + zoom
  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    const { w, h } = size;
    const minSide = Math.min(w, h);
    const target: [number, number, number] = [focusNode.x, focusNode.y, focusNode.r * 2 + (focusNode === root ? 0 : 30)];
    const start = viewRef.current ?? target;

    svg.attr('viewBox', `${-w / 2} ${-h / 2} ${w} ${h}`);
    let g = svg.select<SVGGElement>('g.pack');
    if (g.empty()) {
      g = svg.append('g').attr('class', 'pack');
      g.append('g').attr('class', 'circles');
      g.append('g').attr('class', 'map-links');
      g.append('g').attr('class', 'labels');
    }
    const all = root.descendants().filter((d) => d.data.id !== VROOT);
    const isInFocus = (d: PNode) => {
      let p: PNode | null = d;
      while (p) {
        if (p === focusNode) return true;
        p = p.parent;
      }
      return false;
    };

    const circles = g
      .select('.circles')
      .selectAll<SVGCircleElement, PNode>('circle')
      .data(all, (d) => d.data.id)
      .join('circle')
      .attr('class', (d) => `pack-node ${d.children ? 'branch' : 'leaf'}`)
      .style('fill', (d) => d.data.color)
      .style('stroke', (d) => d.data.color)
      .style('fill-opacity', (d) => (d.children ? Math.min(0.08 + d.depth * 0.05, 0.3) : 0.85))
      .on('click', (ev: MouseEvent, d) => {
        ev.stopPropagation();
        const st = useStore.getState();
        if (d.children && d.data.id !== st.focusId) {
          st.setFocus(d.data.id);
          st.select(d.data.id);
        } else st.select(d.data.id);
      })
      .on('contextmenu', (ev: MouseEvent, d) => {
        ev.preventDefault();
        useStore.getState().select(d.data.id);
        openNodeMenu(d.data.id, ev.clientX, ev.clientY);
      })
      .on('mouseenter', (_e, d) => setHoverId(d.data.id))
      .on('mouseleave', () => setHoverId(null));
    circles.selectAll('title').remove();
    circles.append('title').text((d) => d.data.title);

    const labels = g
      .select('.labels')
      .selectAll<SVGTextElement, PNode>('text')
      .data(all, (d) => d.data.id)
      .join('text')
      .attr('class', (d) => `pack-label ${d.children ? 'branch' : 'leaf'}`)
      .attr('text-anchor', 'middle')
      .text((d) => (d.data.icon ? `${d.data.icon} ${d.data.title}` : d.data.title));

    svg.on('click', () => {
      const st = useStore.getState();
      if (!st.focusId) return;
      const p = byId.get(st.focusId)?.parent;
      st.setFocus(p && p.data.id !== VROOT ? p.data.id : null);
    });

    const apply = (v: [number, number, number]) => {
      viewRef.current = v;
      const k = minSide / v[2];
      circles
        .attr('transform', (d) => `translate(${(d.x - v[0]) * k},${(d.y - v[1]) * k})`)
        .attr('r', (d) => d.r * k);
      labels.each(function (d) {
        const sr = d.r * k;
        const rel = d.depth - focusNode.depth;
        const inFocus = isInFocus(d);
        let show = false;
        let size = 12;
        if (inFocus && rel === 1) {
          show = sr > 14;
          size = Math.max(11, Math.min(20, sr / 4.5));
        } else if (inFocus && rel === 2) {
          show = d.children ? sr > 30 : sr > 16;
          size = Math.max(9.5, Math.min(14, sr / 4.2));
        } else if (inFocus && rel === 3) {
          show = d.children ? sr > 46 : sr > 22;
          size = Math.max(9, Math.min(11, sr / 4));
        }
        const el = d3.select(this);
        el.attr('display', show ? null : 'none');
        if (!show) return;
        const top = d.children && sr > 40;
        const maxChars = Math.max(4, Math.floor((sr * 2) / (size * 0.58)));
        const label = d.data.icon ? `${d.data.icon} ${d.data.title}` : d.data.title;
        el.text(label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label)
          .style('font-size', `${size}px`)
          .attr('x', (d.x - v[0]) * k)
          .attr('y', (d.y - v[1]) * k + (top ? -sr + size + 6 : size * 0.35));
      });
      drawLinks(v);
    };

    const drawLinks = (v: [number, number, number]) => {
      const k = minSide / v[2];
      const visible = links.filter((l) => {
        const a = byId.get(l.s);
        const b = byId.get(l.t);
        return a && b && isInFocus(a) && isInFocus(b);
      });
      g.select('.map-links')
        .selectAll<SVGPathElement, (typeof links)[number]>('path')
        .data(visible, (l) => `${l.s}>${l.t}>${l.label}`)
        .join('path')
        .attr('class', 'map-link')
        .attr('d', (l) => {
          const a = byId.get(l.s)!;
          const b = byId.get(l.t)!;
          const ax = (a.x - v[0]) * k;
          const ay = (a.y - v[1]) * k;
          const bx = (b.x - v[0]) * k;
          const by = (b.y - v[1]) * k;
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2 - Math.hypot(bx - ax, by - ay) * 0.25;
          return `M${ax},${ay}Q${mx},${my} ${bx},${by}`;
        });
    };

    const same = start[0] === target[0] && start[1] === target[1] && start[2] === target[2];
    if (same) apply(target);
    else {
      const interp = d3.interpolateZoom(start, target);
      svg
        .transition()
        .duration(Math.min(1100, Math.max(450, interp.duration * 0.6)))
        .ease(d3.easeCubicInOut)
        .tween('zoom', () => (t) => apply(interp(t) as [number, number, number]));
    }
    return () => {
      svg.interrupt();
    };
  }, [root, byId, focusNode, size, links]);

  // selection / hover styling
  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    const related = new Set<string>();
    if (hoverId) {
      for (const l of links) {
        if (l.s === hoverId) related.add(l.t);
        if (l.t === hoverId) related.add(l.s);
      }
    }
    svg
      .selectAll<SVGCircleElement, PNode>('circle.pack-node')
      .classed('selected', (d) => d.data.id === selectedId)
      .classed('hover', (d) => d.data.id === hoverId)
      .classed('related', (d) => related.has(d.data.id))
      .classed('flash', (d) => !!flash[d.data.id]);
    svg.selectAll<SVGPathElement, { s: string; t: string }>('path.map-link').classed('hl', (l) => l.s === hoverId || l.t === hoverId);
    svg.classed('hovering', !!hoverId && related.size > 0);
  }, [selectedId, hoverId, links, flash, root]);

  const hovered = hoverId ? data.nodes[hoverId] : null;
  return (
    <div className="map-wrap" ref={wrapRef}>
      <svg ref={svgRef} className="map-svg" role="img" aria-label="Zoomable map of the hierarchy" />
      <div className="map-hint">
        {hovered ? (
          <>
            <b>
              {hovered.icon} {hovered.title}
            </b>
            {(index.descCount.get(hovered.id) ?? 0) > 0 ? ` · ${index.descCount.get(hovered.id)} nested — click to zoom in` : ' · click to open'}
          </>
        ) : effFocusId === VROOT ? (
          'Click a circle to zoom in · right-click for actions'
        ) : (
          'Click the background to zoom out'
        )}
      </div>
    </div>
  );
}
