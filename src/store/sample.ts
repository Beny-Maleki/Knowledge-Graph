import type { GraphData, KNode } from '../types';
import { makeLink, makeNode } from '../lib/tree';

interface Spec {
  title: string;
  icon?: string;
  content?: string;
  tags?: string[];
  children?: Spec[];
}

const s = (title: string, content = '', children: Spec[] = [], extra: Partial<Spec> = {}): Spec => ({
  title,
  content,
  children,
  ...extra,
});

const GUIDE: Spec = s(
  'Start here',
  `Welcome! This is a **hierarchical knowledge graph**: every idea is a *page*, pages nest into a **forest** of topics, and any two pages can be **linked** with a free-form relation.

**Try this now**

1. In the **Graph** view, *double-click* a big bubble (a group) to unfold it. Double-click again to fold.
2. Switch to **Map** (top bar) and click circles to zoom into finer and finer levels of a topic.
3. Press **Ctrl/⌘ + K** to jump to any page.
4. Open **Digest** to paste notes or an article and turn them into new nodes.

This guide is itself a page — edit it, move it, or delete it whenever you like.`,
  [
    s(
      'Navigating the views',
      `- **Graph** — a force-directed network. Groups are bubbles sized by how much they contain; *double-click* to expand in place. Expanded groups are wrapped in a soft hull, so you always see what belongs together. Links into a collapsed group are bundled into one dashed edge.
- **Map** — zoomable circle packing. Click a circle to dive in, click the background to go back up. It is the best view for "zooming into" the hierarchy.
- **Tree** — a left-to-right mind map of the same structure.
- **Focus** (\`⤵ Dive in\` on a page) makes a node the root of every view. Breadcrumbs at the top take you back out.

Shortcuts: **Shift + drag** from one node to another (Graph view) creates a link · **Delete** removes the selected node · **Ctrl/⌘ + Z** undo.`,
      [],
      { icon: '🧭' },
    ),
    s(
      'Writing pages',
      `Pages use Markdown with a few extras:

- \`[[Page title]]\` creates a **wiki link** (it also appears as a dotted edge in the graph). Type \`[[\` to get suggestions.
- Math: inline $e^{i\\pi} + 1 = 0$ or display blocks with \`$$ … $$\`.
- Tables, task lists, code blocks, quotes and images (paste an image straight into the editor).

Use **Relations** at the bottom of a page for labelled links like *"uses"*, *"contrasts with"* or *"is evidence for"* — you are not limited to *is-a* / *has-a*.`,
      [],
      { icon: '✍️' },
    ),
    s(
      'Digest pipeline',
      `**Digest** turns raw material into structured knowledge:

1. **Source** — paste text, drop a \`.md\` / \`.txt\` / \`.pdf\` file, or fetch a web page.
2. **Method** — *Outline parser* (free, offline: headings and bullets become nodes) or *AI digest* (an LLM extracts concepts, writes notes, places them into **your existing hierarchy** and proposes links).
3. **Review** — every proposed node and link is shown before anything changes. Untick what you don't want, rename things, then apply. Everything is undoable.

AI features need an API key (Settings). Keys stay in your browser and are sent only to the provider you choose. Local models (Ollama, LM Studio) work too.`,
      [],
      { icon: '🧪' },
    ),
    s(
      'Growing and pruning',
      `- **✨ Expand** on any page proposes sub-topics and links to related pages you already have.
- **✨ Write** drafts the page body from its place in the graph.
- **Health** finds stubs, near-duplicate titles, broken wiki links, lonely nodes and over-crowded groups — with one-click merge / delete / create actions.
- **AI review** proposes merges, moves, renames and new groupings for a whole branch.`,
      [],
      { icon: '🌱' },
    ),
    s(
      'Your data',
      `Everything is stored **locally in your browser** (IndexedDB) and saved automatically.

- **Data → Export** gives you a JSON backup or a Markdown vault (folders = hierarchy) that opens in Obsidian.
- **Data → Import** accepts that JSON, Markdown files / folders, or a **Notion export** (.zip, "Markdown & CSV").
- **Settings → Sync** can mirror the workspace to a private GitHub Gist so you can use it on several devices.`,
      [],
      { icon: '💾' },
    ),
  ],
  { icon: '👋' },
);

const ML: Spec = s(
  'Machine Learning',
  'The study of algorithms that **improve through experience** — learning patterns from data instead of being explicitly programmed.\n\n> "A computer program is said to learn from experience *E* with respect to some task *T* and performance measure *P* if its performance at *T*, as measured by *P*, improves with experience *E*." — Tom Mitchell',
  [
    s('Supervised Learning', 'Learning a mapping $f: X \\to Y$ from **labelled** examples $(x_i, y_i)$.', [
      s('Regression', 'Predicting a **continuous** target.', [
        s(
          'Linear Regression',
          'Models the target as a weighted sum of features:\n\n$$\\hat{y} = w^\\top x + b$$\n\nFit by minimising mean squared error, either in closed form (normal equations) or with [[Gradient Descent]].',
        ),
        s('Polynomial Regression', 'Linear regression on polynomial features $x, x^2, \\dots, x^d$. High $d$ invites [[Overfitting]].'),
      ]),
      s('Classification', 'Predicting a **discrete** class label.', [
        s(
          'Logistic Regression',
          'Despite the name, a classifier. Squashes a linear score through the sigmoid:\n\n$$p(y=1\\mid x) = \\sigma(w^\\top x) = \\frac{1}{1+e^{-w^\\top x}}$$',
        ),
        s('Decision Trees', 'Recursively split the feature space on the most informative feature (Gini impurity / information gain). Interpretable but high-variance.'),
        s('Support Vector Machines', 'Find the **maximum-margin** hyperplane. The kernel trick allows non-linear boundaries without explicit feature maps.'),
        s('k-Nearest Neighbours', 'Classify by majority vote of the $k$ closest training points. No training phase; prediction cost grows with data size.'),
      ]),
    ]),
    s('Unsupervised Learning', 'Finding structure in **unlabelled** data.', [
      s('Clustering', 'Grouping similar points together.', [
        s('k-Means', 'Alternate between assigning points to the nearest centroid and moving centroids to the mean of their points. Sensitive to initialisation — use k-means++.'),
        s('DBSCAN', 'Density-based clustering: finds arbitrarily shaped clusters and labels sparse points as noise.'),
      ]),
      s('Dimensionality Reduction', 'Compressing many features into a few informative ones.', [
        s('Principal Component Analysis', 'Projects data onto the directions of maximum variance — the top eigenvectors of the covariance matrix.'),
        s('t-SNE', 'Non-linear embedding that preserves **local** neighbourhoods; great for visualisation, not for distances between clusters.'),
      ]),
    ]),
    s('Deep Learning', 'Machine learning with **many-layered neural networks** that learn hierarchical representations.', [
      s('Neural Network Basics', '', [
        s('Perceptron', 'The simplest neuron: $y = \\text{step}(w^\\top x + b)$. Can only separate linearly separable data.'),
        s('Activation Functions', 'Non-linearities between layers — ReLU, sigmoid, tanh, GELU. Without them a deep network collapses to a linear map.'),
        s('Backpropagation', 'Efficiently computes the gradient of the loss with respect to every weight by applying the chain rule backwards through the network.'),
      ]),
      s('Convolutional Networks', 'Share weights across space with learned filters; the workhorse of computer vision.'),
      s('Transformers', 'Architecture built entirely on attention; the basis of modern language models.', [
        s('Attention', 'Each token builds its representation as a weighted mix of all tokens:\n\n$$\\text{Attention}(Q,K,V) = \\text{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V$$'),
        s('Positional Encoding', 'Injects token order, since attention itself is permutation-invariant.'),
      ]),
    ]),
    s('Optimization', 'How model parameters are actually found.', [
      s('Gradient Descent', 'Repeatedly step against the gradient: $\\theta \\leftarrow \\theta - \\eta \\nabla_\\theta L$. Stochastic variants use mini-batches.'),
      s('Adam', 'Adaptive per-parameter learning rates from running estimates of the first and second moments of the gradient.'),
    ]),
    s('Model Evaluation', 'Measuring how well a model **generalises** to unseen data.', [
      s('Overfitting', 'The model memorises noise in the training set: low training error, high test error. Counter with regularisation, more data, or simpler models.'),
      s('Cross-Validation', 'Rotate which fold is held out to get a less noisy estimate of generalisation error.'),
      s('Bias–Variance Tradeoff', 'Expected error = bias² + variance + irreducible noise. Simple models → high bias; flexible models → high variance.'),
    ]),
  ],
  { icon: '🤖' },
);

const MATH: Spec = s(
  'Mathematics',
  'The foundations that machine learning is built on.',
  [
    s('Linear Algebra', '', [
      s('Vectors', 'Ordered lists of numbers; points or directions in space. Dot product $a \\cdot b = \\sum_i a_i b_i$.'),
      s('Matrices', 'Linear maps between vector spaces. Matrix multiplication composes maps.'),
      s('Eigenvalues and Eigenvectors', '$Av = \\lambda v$: directions that $A$ only stretches. They reveal the "axes" of a transformation.'),
    ]),
    s('Calculus', '', [
      s('Derivatives', 'Instantaneous rate of change. The gradient $\\nabla f$ collects all partial derivatives and points uphill.'),
      s('Chain Rule', '$\\frac{d}{dx} f(g(x)) = f\'(g(x))\\,g\'(x)$ — the engine behind [[Backpropagation]].'),
    ]),
    s('Probability', '', [
      s("Bayes' Theorem", '$$P(A\\mid B) = \\frac{P(B\\mid A)\\,P(A)}{P(B)}$$\n\nUpdating beliefs with evidence.'),
      s('Probability Distributions', 'Gaussian, Bernoulli, categorical, … A model\'s output is often a distribution, not a single answer.'),
    ]),
  ],
  { icon: '📐' },
);

const LINKS: [string, string, string][] = [
  ['Backpropagation', 'Chain Rule', 'applies'],
  ['Principal Component Analysis', 'Eigenvalues and Eigenvectors', 'is computed from'],
  ['Gradient Descent', 'Derivatives', 'follows'],
  ['Logistic Regression', 'Probability Distributions', 'outputs a'],
  ['Attention', 'Matrices', 'is built from'],
  ['Adam', 'Gradient Descent', 'improves on'],
  ['Backpropagation', 'Gradient Descent', 'feeds'],
  ['Perceptron', 'Logistic Regression', 'is a cousin of'],
  ['Polynomial Regression', 'Bias–Variance Tradeoff', 'illustrates'],
  ['Decision Trees', 'Overfitting', 'is prone to'],
  ['k-Means', 'Principal Component Analysis', 'often follows'],
  ['Cross-Validation', 'Overfitting', 'detects'],
  ['Convolutional Networks', 'Transformers', 'competes with'],
  ['Logistic Regression', "Bayes' Theorem", 'contrasts with'],
];

export function sampleData(): GraphData {
  const nodes: Record<string, KNode> = {};
  const byTitle = new Map<string, string>();
  const base = Date.now();
  let order = 1;
  const build = (spec: Spec, parentId: string | null) => {
    const n = makeNode({
      title: spec.title,
      content: spec.content,
      icon: spec.icon,
      tags: spec.tags ?? [],
      parentId,
      order: order++,
      createdAt: base,
      updatedAt: base,
    });
    nodes[n.id] = n;
    byTitle.set(spec.title, n.id);
    for (const c of spec.children ?? []) build(c, n.id);
  };
  for (const root of [GUIDE, ML, MATH]) build(root, null);
  const links: GraphData['links'] = {};
  for (const [a, b, label] of LINKS) {
    const s1 = byTitle.get(a);
    const t1 = byTitle.get(b);
    if (s1 && t1) {
      const l = makeLink(s1, t1, label);
      links[l.id] = l;
    }
  }
  return { nodes, links };
}
