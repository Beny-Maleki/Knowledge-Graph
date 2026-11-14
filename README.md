# Knowledge Graph

**Organise what you learn as a zoomable forest of rich pages.**
Free, open-source and local-first, with no account or server.

**Live app:** https://beny-maleki.github.io/Knowledge-Graph/

Every idea is a **page** (Markdown with math, images and wiki links). Pages nest into a
**hierarchy** (a forest of topic trees), and any two pages can be connected by a
**free-form, labelled relation** ("uses", "contrasts with", "is evidence for"…), so you aren't limited to *is-a* / *has-a*.
Zoom in and the hierarchy unfolds into finer and finer detail.

A built-in **pipeline** turns raw material (notes, articles, PDFs, web pages) into new
pages placed inside your existing structure, and helps you **expand** and **prune** the graph over time.

---

## Features

### Three ways to see the same knowledge
| View | What it's for |
| --- | --- |
| **Graph** | Force-directed network. Groups are bubbles sized by what they contain. **Double-click** to unfold a group in place. Unfolded groups are wrapped in a soft hull, and links into a folded group are bundled into one dashed edge. **Shift + drag** between nodes creates a relation. |
| **Map** | Zoomable nested circles. Click a circle to zoom into it and see the next level of detail; click the background to zoom out. |
| **Tree** | A left-to-right mind map of the hierarchy, with relations drawn as dashed arcs. |

- **Dive in / focus**: make any page the root of every view; breadcrumbs take you back out.
- **Levels 1–N**: unfold everything down to a given depth in one click.
- Hover to highlight a node's neighbourhood. Right-click any node for its actions.

### Notion-like pages
- Markdown editor with `[[wiki link]]` autocomplete, KaTeX math (`$…$`, `$$…$$`), tables, task lists, code, quotes and pasted images.
- Icons, colours, tags, sources, sub-page cards, and outgoing and incoming relations with editable labels.
- Drag-and-drop outline in the sidebar to reorder and re-parent pages.
- `Ctrl/⌘ K` search across titles, tags and notes. Full undo / redo.

### The pipeline: digest → expand → prune
- **Digest** (top bar): paste text, drop `.md` / `.txt` / `.pdf` / `.html` files, or fetch a web page.
  - **Outline parser** (free, offline): headings, bullets or indentation become pages; the text under them becomes notes.
  - **AI digest**: an LLM extracts concepts, writes concise notes, **places them into your existing hierarchy**, merges new facts into pages you already have instead of duplicating them, and proposes relations.
  - Every proposal is shown for **review** first. Untick items or rename them, then apply. Every change can be undone.
- **✨ Expand** a page: proposes sub-topics (one or two levels) plus links to related pages you already have.
- **✨ Write** a page: drafts or improves the body using its place in the graph.
- **🩺 Health**: finds near-duplicate titles, empty stubs, broken wiki links, single-child chains, crowded groups and very deep pages, each with a one-click fix (merge, create, delete, organise…).
- **✨ Review a branch**: the AI proposes merges, moves, renames, deletions and new groupings, and you pick which to apply.

### Accounts & cloud sync (optional)
- **Sign in** (☁ in the top bar) to store your graph in the cloud and use it on any device. Without an account, everything still works and stays in your browser.
- Email + password sign-up, password reset, sign-in by email link, plus GitHub/Google sign-in if you enable them in Supabase.
- **Workspaces**: keep separate graphs (e.g. one per subject) and switch between them from the sidebar.
- **Offline-first**: each workspace is also cached on the device; edits made offline sync when you're back online. Pages sync individually, so editing different pages on two devices never conflicts; for the same page, the newer edit wins.
- Profile name, password change, sign out (removes the synced copy from that device), and **delete account** (removes all your cloud data).
- Backend: [Supabase](https://supabase.com) free tier (Postgres + Auth). Every table uses row-level security, so a signed-in user can only ever read or write their own rows.

### Roles, two-factor sign-in & the Claude connector
- **Roles**: new sign-ups are *pending* and can only use the app locally. An admin approves them as *member* (cloud sync, workspaces, Claude connector) under **Account → 👥 Manage users**. Admins can't read anyone's notes.
- **Two-factor authentication** with an authenticator app (Google Authenticator, Authy, 1Password…). It's free and sends no email or SMS. It's required for admins, and anyone who turns it on must use it at every sign-in.
- **Connect Claude**: under **Account → Connect Claude**, create a connector link. In claude.ai open **Settings → Connectors → Add custom connector** and paste the link. Claude can then read your outline, search and read pages, and add pages and relations (duplicates are merged), plus update or delete pages and remove relations. Links can expire and can be revoked at any time; only a hash of each link is stored.

### Your data stays yours
- Saved automatically in your browser (IndexedDB). Nothing is sent anywhere unless you use AI or Sync.
- **Export**: lossless JSON backup, or a **Markdown vault** (`.zip`, folders = hierarchy, relations as wiki links) that opens in Obsidian.
- **Import**: that JSON, Markdown files or folders, Obsidian vaults, or a **Notion export** (`.zip`, "Markdown & CSV"). Page nesting becomes the hierarchy and links between pages become relations.
- **Sync** (optional): mirror the workspace to a private **GitHub Gist** so it follows you across devices.

---

## Setting up AI (optional)

Everything except Digest-with-AI / Expand / Write / Review works without AI.
Open **⚙ Settings → AI** and choose one of:

- **Claude (Anthropic)**: paste an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys).
  The default model is Claude Opus 5.5; Sonnet 5.5, Haiku 5.5 and Fable 5.1 can be selected, and *Effort* trades speed for depth.
  Calls go straight from your browser to `api.anthropic.com` through the official SDK, with structured JSON output.
- **Local / OpenAI-compatible**: any `/chat/completions` endpoint. Presets are included for **Ollama**, LM Studio, OpenRouter, Google Gemini, Groq and OpenAI.
  For Ollama, allow this site to call it:
  ```bash
  OLLAMA_ORIGINS="https://beny-maleki.github.io" ollama serve
  ```

Keys are stored only in your browser (or only for the session, if you untick "Remember keys"). They are never sent anywhere except to the provider you chose.

> Web pages are fetched through the public [r.jina.ai](https://r.jina.ai) reader, because browsers can't read other sites directly (CORS).

---

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl/⌘ K` | Search / jump / create |
| `N` | New sub-page of the selected page |
| `Delete` | Delete the selected page |
| `Ctrl/⌘ Z`, `Ctrl/⌘ Shift Z` | Undo, redo |
| `1` `2` `3` | Graph, Map, Tree |
| `Esc` | Close page / dialog |
| `?` | Help |

---

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (vitest)
npm run build      # production build in dist/
```

Stack: React 19 + TypeScript + Vite, D3 (force, pack, tree, zoom), Zustand, CodeMirror 6, marked + KaTeX + DOMPurify, idb-keyval, fflate, pdf.js, and the Anthropic TypeScript SDK (loaded on demand).

```
src/
  types.ts              data model (KNode, KLink, Proposal, PruneOp)
  store/                Zustand store (undo/redo), IndexedDB persistence, sample graph
  lib/
    tree.ts             hierarchy index, colours, wiki links, similarity
    ops.ts              pure graph operations (move, merge, delete, apply proposal / prune ops)
    pipeline.ts         AI prompts + JSON schemas + proposal normalisation
    llm.ts              Claude (official SDK) and OpenAI-compatible providers
    outline.ts          offline Markdown / outline parser
    interchange.ts      JSON, Markdown vault, Notion import/export
    health.ts           graph health checks
  components/           Graph / Map / Tree views, page panel, dialogs
```

### Supabase backend

- `supabase/migrations/`: the database schema (tables, row-level security, roles/2FA rules, admin functions).
- `supabase/functions/mcp/`: the Claude connector (Edge Function). Deploy it with JWT verification **off**, because it checks its own tokens.


The database schema (profiles, workspaces, `kg_nodes`, `kg_links`, row-level-security policies, and a `delete_my_account()` function) lives in your Supabase project.
The client reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` and falls back to the project in `src/lib/supabase.ts`. The publishable key is meant to be public; security comes from row-level security.

Recommended dashboard settings (Authentication):
- **URL Configuration** → Site URL `https://beny-maleki.github.io/Knowledge-Graph/`; also add `http://localhost:5173/` to Redirect URLs for development.
- **Emails**: the built-in mailer on the free plan sends only a few emails per hour, and only to your project's team members. To let others sign up with email confirmation, add a free custom SMTP provider; or, for an invite-only setup, turn off sign-ups and create users under **Users → Add user** with "Auto confirm".

### Deployment

`.github/workflows/deploy.yml` runs the tests and builds on every push to `main` (and the current development branch), then publishes the site.

GitHub Pages serves that branch (**Settings → Pages → Deploy from a branch → `gh-pages` / root**).

## License

[MIT](LICENSE)
