import { Marked, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMath(tex: string, displayMode: boolean) {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: 'htmlAndMathml' });
  } catch {
    return `<code>${escapeAttr(tex)}</code>`;
  }
}

const wikiLink: TokenizerAndRendererExtension = {
  name: 'wikiLink',
  level: 'inline',
  start(src) {
    return src.indexOf('[[');
  },
  tokenizer(src) {
    const m = /^\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (m) return { type: 'wikiLink', raw: m[0], target: m[1].trim(), alias: (m[2] ?? m[1]).trim() };
    return undefined;
  },
  renderer(token) {
    return `<a href="#" class="wikilink" data-wiki="${escapeAttr(token.target)}">${escapeAttr(token.alias)}</a>`;
  },
};

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    return src.indexOf('$$');
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
    if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer(token) {
    return `<div class="math-block">${renderMath(token.text, true)}</div>`;
  },
};

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const i = src.indexOf('$');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const display = /^\$\$([^$]+?)\$\$/.exec(src);
    if (display) return { type: 'inlineMath', raw: display[0], text: display[1].trim(), display: true };
    // $…$ with no space just inside the delimiters (so "$5 and $6" stays text).
    const m = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1], display: false };
    return undefined;
  },
  renderer(token) {
    return renderMath(token.text, !!token.display);
  },
};

const md = new Marked({ gfm: true, breaks: false });
md.use({ extensions: [blockMath, inlineMath, wikiLink] });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
});

const cache = new Map<string, string>();

/**
 * Render page markdown to sanitised HTML. `exists` decides whether a wiki
 * link target is present (missing ones get a different style).
 */
export function renderMarkdown(src: string, exists?: (title: string) => boolean): string {
  let html = cache.get(src);
  if (html === undefined) {
    const raw = md.parse(src, { async: false }) as string;
    html = DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      ADD_ATTR: ['data-wiki', 'target'],
    });
    if (cache.size > 400) cache.clear();
    cache.set(src, html);
  }
  if (exists && html.includes('data-wiki')) {
    html = html.replace(/<a href="#" class="wikilink" data-wiki="([^"]*)"/g, (m, t) => {
      const title = t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      return exists(title) ? m : m.replace('class="wikilink"', 'class="wikilink missing"');
    });
  }
  return html;
}
