/** Reading source material: text/markdown files, PDFs (lazy pdf.js) and web pages. */

export async function readSourceFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return extractPdfText(file);
  if (name.endsWith('.html') || name.endsWith('.htm')) return htmlToText(await file.text());
  return file.text();
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY: number | null = null;
    let line = '';
    const lines: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = '';
      }
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
        lastY = null;
        continue;
      }
      lastY = y;
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
  }
  await task.destroy();
  return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,nav,footer,header,aside').forEach((n) => n.remove());
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${child.textContent?.trim()}`);
      else if (tag === 'li') out.push(`- ${child.textContent?.trim().replace(/\s+/g, ' ')}`);
      else if (tag === 'p' || tag === 'pre' || tag === 'blockquote') out.push(child.textContent?.trim() ?? '');
      else walk(child);
    }
  };
  walk(doc.body);
  return out.filter(Boolean).join('\n\n');
}

/**
 * Fetch a web page as Markdown through the public r.jina.ai reader (browsers
 * cannot fetch arbitrary sites directly because of CORS).
 */
export async function fetchUrlAsMarkdown(url: string, signal?: AbortSignal): Promise<{ title: string; text: string }> {
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error('Enter a full URL starting with http:// or https://');
  const res = await fetch(`https://r.jina.ai/${clean}`, { signal, headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error(`Could not fetch the page (HTTP ${res.status}).`);
  const raw = await res.text();
  const title = /^Title:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? clean;
  const body = raw.includes('Markdown Content:') ? raw.split('Markdown Content:').slice(1).join('Markdown Content:') : raw;
  return { title, text: body.trim() };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFileName(s: string): string {
  return (
    s
      .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Untitled'
  );
}
