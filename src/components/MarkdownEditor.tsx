import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { autocompletion, closeBrackets, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { useStore } from '../store/store';
import { fuzzyScore } from '../lib/search';

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.45em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.25em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.1em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--code)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--muted)' },
  { tag: t.list, color: 'var(--accent)' },
]);

function wikiCompletions(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/\[\[[^\]\n]*/);
  if (!m) return null;
  const q = m.text.slice(2);
  const nodes = Object.values(useStore.getState().data.nodes);
  const scored = nodes
    .map((n) => ({ n, s: fuzzyScore(q, n.title) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 30);
  return {
    from: m.from + 2,
    options: scored.map(({ n }) => ({
      label: n.title,
      detail: n.icon,
      apply: (view, _c, from, to) => {
        const after = view.state.sliceDoc(to, to + 2);
        const insert = n.title + (after === ']]' ? '' : ']]');
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (after === ']]' ? 2 : 0) } });
      },
    })),
    validFor: /^[^\]\n]*$/,
  };
}

/** Downscale pasted images so pages stay light (they are stored inline). */
async function imageToDataUrl(file: File, maxSide = 1400): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('image load failed'));
      img.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface EditorHandle {
  wrap: (before: string, after?: string, placeholder?: string) => void;
  linePrefix: (prefix: string) => void;
  insert: (text: string) => void;
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  handleRef?: React.MutableRefObject<EditorHandle | null>;
}

export function MarkdownEditor({ value, onChange, placeholder, autoFocus, handleRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        closeBrackets(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdHighlight),
        autocompletion({ override: [wikiCompletions], icons: false }),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          { key: 'Mod-b', run: (v) => (wrapSel(v, '**', '**', 'bold'), true) },
          { key: 'Mod-i', run: (v) => (wrapSel(v, '*', '*', 'italic'), true) },
          { key: 'Mod-k', run: (v) => (wrapSel(v, '[[', ']]', 'Page'), true) },
        ]),
        cmPlaceholder(placeholder ?? ''),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          paste: (ev, view) => {
            const file = Array.from(ev.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
            if (!file) return false;
            ev.preventDefault();
            imageToDataUrl(file)
              .then((url) => {
                const pos = view.state.selection.main.head;
                view.dispatch({ changes: { from: pos, insert: `![pasted image](${url})\n` } });
              })
              .catch(() => useStore.getState().toast('Could not read the pasted image', 'error'));
            return true;
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current! });
    viewRef.current = view;
    if (autoFocus) view.focus();
    if (handleRef) {
      handleRef.current = {
        wrap: (b, a = b, ph = 'text') => wrapSel(view, b, a, ph),
        linePrefix: (p) => prefixLines(view, p),
        insert: (text) => {
          const pos = view.state.selection.main.head;
          view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
          view.focus();
        },
        focus: () => view.focus(),
      };
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // external value changes (undo, AI draft, switching nodes)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  return <div className="md-editor" ref={host} />;
}

function wrapSel(view: EditorView, before: string, after: string, ph: string) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to) || ph;
  view.dispatch({
    changes: { from, to, insert: before + text + after },
    selection: { anchor: from + before.length, head: from + before.length + text.length },
  });
  view.focus();
}

function prefixLines(view: EditorView, prefix: string) {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const changes = [];
  for (let pos = doc.lineAt(from).from; pos <= to; ) {
    const line = doc.lineAt(pos);
    changes.push({ from: line.from, insert: prefix });
    if (line.to + 1 > doc.length) break;
    pos = line.to + 1;
    if (pos > to) break;
  }
  view.dispatch({ changes });
  view.focus();
}
