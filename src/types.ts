/** A single knowledge component. Nodes form a forest through `parentId`. */
export interface KNode {
  id: string;
  title: string;
  /** `null` = top-level root of a tree in the forest. */
  parentId: string | null;
  /** Sort key among siblings (ascending). */
  order: number;
  /** Markdown page body. Supports [[Wiki Links]], $math$, tables, code… */
  content: string;
  icon?: string;
  /** Optional hex colour override; otherwise inherited from the branch. */
  color?: string;
  tags: string[];
  /** Where this knowledge came from (URLs, book titles, …). */
  sources: string[];
  createdAt: number;
  updatedAt: number;
}

/** A free-form, optionally labelled relation between any two nodes. */
export interface KLink {
  id: string;
  source: string;
  target: string;
  label: string;
  createdAt: number;
}

export interface GraphData {
  nodes: Record<string, KNode>;
  links: Record<string, KLink>;
}

export interface WorkspaceFile extends GraphData {
  app: 'knowledge-graph';
  version: 1;
  name: string;
  exportedAt: number;
}

export type ViewMode = 'graph' | 'map' | 'tree';

/* ---------- Ingest pipeline ---------- */

/** A node proposed by the pipeline (AI or parser), not yet in the graph. */
export interface ProposedNode {
  /** Temporary reference, unique within the proposal. */
  ref: string;
  title: string;
  /** Existing node id, another proposal `ref`, or null for a new root. */
  parent: string | null;
  content: string;
  tags: string[];
  /** If set, this proposal is merged into an existing node instead of creating one. */
  mergeInto: string | null;
  accepted: boolean;
}

export interface ProposedLink {
  source: string; // existing id or ref
  target: string;
  label: string;
  accepted: boolean;
}

export interface Proposal {
  summary: string;
  nodes: ProposedNode[];
  links: ProposedLink[];
  sources: string[];
}

export type PruneOpKind = 'merge' | 'move' | 'delete' | 'rename' | 'group';

export interface PruneOp {
  kind: PruneOpKind;
  /** The node being changed. */
  node: string;
  /**
   * merge: node to merge into · move: new parent ('' = root) · rename: new title ·
   * group: title of the new group created under `node` ('' node = root level).
   */
  target: string;
  /** group: the nodes moved into the new group. */
  members?: string[];
  reason: string;
  accepted: boolean;
}
