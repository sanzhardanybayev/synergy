// @ts-check
// panel.js - vanilla-DOM webview UI for the Synergy Review pane. No framework: the message
// protocol (see src/panel/messages.ts) is small enough that hand-written DOM updates stay
// readable, and skipping React/Vue keeps the extension bundle tiny.
//
// This file is the SOURCE. esbuild.mjs bundles it (with its syntax-highlighting import) to
// `media/panel.js`, which is what the webview actually loads - see src/panel/webview-html.ts.
//
// Type-checked (loosely - see tsconfig.media.json) against the JSDoc typedef below so a
// mistake like reading `serializedBundle.bundle.drift` (drift is a SIBLING of `bundle`, not
// nested under it - see src/panel/messages.ts) is a compile error, not a silently-dead badge.
//
/**
 * @typedef {object} SerializedBundle
 * @property {{workspace: any, snapshot: any, insights: any, progress: any}} bundle
 * @property {Record<string, 'clean'|'drifted'|'missing'>} drift
 * @property {string} projectRoot
 */
import { buildRemovalStrips, resolveBrowserReviewItemContext } from '@synergy/review-core/browser';
import { highlightHunk, resolveLanguage } from '@synergy/review-core/highlight';

/**
 * Module-scope DOM helpers live outside `startWebview()` (rather than in the IIFE the rest of
 * this file used to be, before removal-strip rendering needed to be unit-testable) so
 * `renderDiffLines`/`renderRemovalStrip` can be imported and exercised directly under vitest +
 * jsdom without executing `startWebview()` - which calls `acquireVsCodeApi()`, a global that
 * only exists inside a real VS Code webview. See the `export` and the guarded call at the
 * bottom of this file.
 */

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'style') {
      // The CSP declares `style-src` without 'unsafe-inline', so a `style` ATTRIBUTE is
      // blocked and silently no-ops. Set `node.style.<property>` (CSSOM) on the returned
      // element instead - CSSOM writes are not subject to style-src.
      throw new Error('el(): "style" is not supported - set node.style.<property> instead');
    }
    if (key === 'className') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** VS Code stamps `vscode-light` / `vscode-dark` / `vscode-high-contrast` on <body>. */
function themeMode() {
  return document.body.classList.contains('vscode-light') ? 'light' : 'dark';
}

/**
 * Replaces a line's plain text with syntax token spans.
 *
 * The CSP forbids inline `style` ATTRIBUTES, so each token color is written through CSSOM. The
 * `+`/`-` marker keeps no inline color, so it still inherits the add/remove color from panel.css
 * while the code itself takes the syntax palette; the row background carries add/remove either way.
 */
function paintTokens(textEl, marker, tokens) {
  if (!textEl.isConnected || !tokens || tokens.length === 0) return;
  const markerEl = el('span', { className: 'diff-marker' }, [marker]);
  const spans = tokens.map((token) => {
    const span = el('span', {}, [token.text]);
    if (token.color) span.style.color = token.color;
    if (token.italic) span.style.fontStyle = 'italic';
    if (token.bold) span.style.fontWeight = '600';
    return span;
  });
  textEl.replaceChildren(markerEl, ...spans);
}

/** Human label for each removal reason; mirrors REASON_LABEL in packages/preview/src/review/RemovalStrip.tsx. */
const REMOVAL_REASON_LABEL = {
  moved: 'moved',
  merged: 'merged',
  replaced: 'replaced',
  'dead-code': 'dead-code',
  obsolete: 'obsolete',
  'extracted-to-dep': 'extracted to dep',
};

/**
 * One collapsed row per removal run: category, size, and (when resolvable) a jump destination
 * stay visible while scanning. Expanding reveals the rationale sentence and, for a target outside
 * the captured review, a read-only peek of the destination lines plus an "open in editor" action.
 * Mirrors packages/preview/src/review/RemovalStrip.tsx; class names follow this file's existing
 * (unprefixed, single-hyphen) naming instead of that file's `review-removal__` BEM convention.
 *
 * A run with no rationale renders nothing - returns `null`, same contract as the preview.
 *
 * @param {import('@synergy/review-core/browser').RemovalStrip} strip
 * @param {{onJumpToReviewItem:(reviewItemId:string)=>void, onOpenFile:(path:string, line:number)=>void}} handlers
 */
function renderRemovalStrip(strip, handlers) {
  const { rationale, run, target } = strip;
  if (!rationale) return null;
  const count = run.end - run.start + 1;

  const caret = el('span', { className: 'removal-caret', 'aria-hidden': 'true' }, ['▸']);
  const cat = el('span', { className: `removal-cat removal-cat-${rationale.reason}` }, [
    REMOVAL_REASON_LABEL[rationale.reason] ?? rationale.reason,
  ]);
  const countLabel = el('span', { className: 'removal-count' }, [
    `${count} ${count === 1 ? 'line' : 'lines'} removed`,
  ]);

  const detail = el('div', { className: 'removal-detail' }, [el('p', {}, [rationale.description])]);
  if (target.kind === 'excerpt') {
    const peekHead = el('div', { className: 'removal-peek-head' }, [
      `${target.path} · lines ${target.start}-${target.start + target.lines.length - 1}`,
    ]);
    const pre = el(
      'pre',
      {},
      target.lines.map((line) => el('div', {}, [line])),
    );
    const openButton = el(
      'button',
      {
        type: 'button',
        className: 'removal-open-file',
        'data-open-path': target.path,
        'data-open-line': String(target.start),
        onClick: (event) => {
          event.stopPropagation();
          handlers.onOpenFile(target.path, target.start);
        },
      },
      ['Open in editor'],
    );
    detail.appendChild(el('div', { className: 'removal-peek' }, [peekHead, pre]));
    detail.appendChild(openButton);
  }

  const toggle = el(
    'button',
    {
      type: 'button',
      className: 'removal-toggle',
      'aria-expanded': 'false',
      onClick: (event) => {
        event.stopPropagation();
        const expanded = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(expanded));
        caret.textContent = expanded ? '▾' : '▸';
        container.classList.toggle('is-expanded', expanded);
      },
    },
    [caret, cat, countLabel],
  );

  const rowChildren = [toggle];
  if (target.kind === 'in-review') {
    rowChildren.push(
      el(
        'button',
        {
          type: 'button',
          className: 'removal-jump',
          onClick: (event) => {
            event.stopPropagation();
            handlers.onJumpToReviewItem(target.reviewItemId);
          },
        },
        [`→ ${target.path}:${target.start}`],
      ),
    );
  }
  const row = el('div', { className: 'removal-row' }, rowChildren);
  const container = el('div', { className: 'removal-strip' }, [row, detail]);
  return container;
}

/**
 * Renders the hunk body with its captured text, then upgrades it to syntax-highlighted spans
 * once the grammar resolves. Highlighting is asynchronous and best-effort: if it never resolves,
 * or the language is unsupported, the reviewer keeps looking at the exact captured lines.
 *
 * When `context` is supplied, also renders one removal-rationale strip (see `renderRemovalStrip`)
 * above each removed run that carries agent-authored rationale - mirrors how
 * packages/preview/src/review/DiffViewer.tsx places `<RemovalStrip>` above its run's first row.
 * Deriving the strips reuses the exact same rows `resolveBrowserReviewItemContext` would hand the
 * preview, so a mismatch between `hunk` and the snapshot (should never happen, but the two are
 * looked up independently) fails soft: no strips, not a broken diff.
 *
 * @param {any} hunk
 * @param {string} path
 * @param {{reviewItemId:string, snapshot:any, insights:any, onJumpToReviewItem:(reviewItemId:string)=>void, onOpenFile:(path:string, line:number)=>void}} [context]
 */
function renderDiffLines(hunk, path, context) {
  const textEls = [];
  let rows = [];
  let strips = [];
  if (context) {
    try {
      const itemContext = resolveBrowserReviewItemContext(context.snapshot, context.reviewItemId);
      rows = itemContext.rows.filter((row) => row.kind !== 'scope');
      strips = buildRemovalStrips(rows, context.reviewItemId, context.snapshot, context.insights);
    } catch {
      rows = [];
      strips = [];
    }
  }
  const stripByRowId = new Map(strips.map((strip) => [strip.run.lineIds[0], strip]));

  const rowNodes = [];
  hunk.lines.forEach((line, index) => {
    const rowId = rows[index]?.id;
    const strip = rowId !== undefined ? stripByRowId.get(rowId) : undefined;
    if (strip && context) {
      const stripEl = renderRemovalStrip(strip, context);
      if (stripEl) rowNodes.push(stripEl);
    }
    const kindClass =
      line.kind === 'add' ? 'diff-line-add' : line.kind === 'remove' ? 'diff-line-remove' : '';
    const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
    const textEl = el('span', { className: 'diff-text' }, [`${marker}${line.text}`]);
    textEls.push({ textEl, marker });
    rowNodes.push(
      el('div', { className: `diff-line ${kindClass}` }, [
        el('span', { className: 'diff-gutter' }, [
          line.oldLine === null ? '' : String(line.oldLine),
        ]),
        el('span', { className: 'diff-gutter' }, [
          line.newLine === null ? '' : String(line.newLine),
        ]),
        textEl,
      ]),
    );
  });

  const lang = resolveLanguage(path);
  if (lang) {
    const rowsForHighlight = hunk.lines.map((line) => ({ kind: line.kind, text: line.text }));
    highlightHunk(rowsForHighlight, lang, themeMode())
      .then((lines) => {
        lines.forEach((tokens, index) => {
          const target = textEls[index];
          if (target) paintTokens(target.textEl, target.marker, tokens);
        });
      })
      .catch(() => {
        // Presentation only - the captured text is already on screen.
      });
  }

  return el('div', { className: 'hunk-diff' }, rowNodes);
}

/**
 * Renders JUST the removal strips for a review item - no diff line bodies - so a reviewer with
 * the diff toggle OFF still sees that a removal run exists and carries a rationale. Without this,
 * collapsing the diff hid every removal strip along with it, silently defeating the coverage gate
 * the whole feature exists to guarantee (every removed run must carry a typed reason). This is
 * the least intrusive presentation available: it reuses `renderRemovalStrip` as-is (same collapsed
 * category/count row, same expand-to-read-the-sentence interaction) rather than inventing a new
 * summary widget, so the strip looks and behaves identically whether the diff is open or closed.
 *
 * @param {{reviewItemId:string, snapshot:any, insights:any, onJumpToReviewItem:(reviewItemId:string)=>void, onOpenFile:(path:string, line:number)=>void}} [context]
 */
function renderRemovalSummary(context) {
  if (!context) return null;
  let rows = [];
  let strips = [];
  try {
    const itemContext = resolveBrowserReviewItemContext(context.snapshot, context.reviewItemId);
    rows = itemContext.rows.filter((row) => row.kind !== 'scope');
    strips = buildRemovalStrips(rows, context.reviewItemId, context.snapshot, context.insights);
  } catch {
    strips = [];
  }
  const stripEls = strips
    .map((strip) => renderRemovalStrip(strip, context))
    .filter((node) => node !== null);
  if (stripEls.length === 0) return null;
  return el('div', { className: 'hunk-diff hunk-diff-collapsed' }, stripEls);
}

function startWebview() {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /**
   * `diffVisible` is the global diff-presentation toggle (inline hunk bodies here, decorations in
   * the editor). It survives webview disposal via `vscode.setState` and is mirrored to the host
   * with a `setDiffVisible` message (on toggle AND on startup, since the host resets to `true`).
   *
   * `revealFloor` and `revealAll` are the pane's local walkthrough reveal state - mirrors the web
   * preview's `localFloorRef` / `walkthroughRevealAll` (see packages/preview/src/review/
   * ReviewProvider.tsx). Neither persists across `vscode.setState` or a bundle refresh; both
   * reset when the open session (workspace + revision) changes - see `walkthroughSessionKey`.
   *
   * @type {{screen: 'sessions'|'bundle', sessions: any[], bundle: SerializedBundle|null, error: string|null, expanded: Set<string>, diffVisible: boolean, revealFloor: number, revealAll: boolean, walkthroughSessionKey: string|null}}
   */
  const state = {
    screen: 'sessions',
    sessions: [],
    bundle: null,
    error: null,
    expanded: new Set(),
    diffVisible: vscode.getState()?.diffVisible !== false,
    revealFloor: 0,
    revealAll: false,
    walkthroughSessionKey: null,
  };

  function setDiffVisible(value) {
    state.diffVisible = value;
    vscode.setState({ ...(vscode.getState() || {}), diffVisible: value });
    post({ kind: 'setDiffVisible', value });
    render();
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  }

  /** @param {SerializedBundle} bundle */
  function itemStatus(bundle, reviewItemId) {
    const progress = bundle.bundle.progress.items[reviewItemId];
    return progress ? progress.status : 'needs-review';
  }

  /** @param {SerializedBundle} bundle */
  function isReviewed(bundle, reviewItemId) {
    const status = itemStatus(bundle, reviewItemId);
    return status === 'reviewed' || status === 'carried-forward';
  }

  // ---- Walkthrough (storytelling) helpers ----
  //
  // Mirrors packages/preview/src/review/walkthrough.ts's `revealedChapterCount`, reimplemented
  // here because the webview has no module imports (see the file banner above).

  /**
   * The count of chapters (groups, in story order) that should be revealed given where the
   * cursor currently sits. 1-based: a cursor inside the Nth group reveals N chapters. No cursor
   * (a fresh walkthrough) reveals just the first chapter.
   *
   * @param {any[]} groups
   * @param {string|undefined} cursorReviewItemId
   */
  function revealedChapterCount(groups, cursorReviewItemId) {
    if (cursorReviewItemId === undefined) return 1;
    for (let index = 0; index < groups.length; index += 1) {
      if (groups[index].reviewItemIds.includes(cursorReviewItemId)) return index + 1;
    }
    return 1;
  }

  /**
   * Sends `advanceWalkthrough` to the extension host and bumps the local reveal floor
   * immediately, so a locked chapter's header or a Continue button expands the pane right away
   * instead of waiting on the bundle round trip. The floor only grows (monotonic), matching the
   * store's own monotonic cursor.
   */
  function sendAdvanceWalkthrough(groupId, reviewItemId) {
    const groups = state.bundle ? state.bundle.bundle.insights.groups || [] : [];
    const chapterIndex = groups.findIndex((group) => group.id === groupId);
    if (chapterIndex + 1 > state.revealFloor) state.revealFloor = chapterIndex + 1;
    post({ kind: 'advanceWalkthrough', groupId, reviewItemId });
    render();
  }

  // ---- Session list screen ----

  function renderSessions() {
    if (state.sessions.length === 0) {
      return el('div', { className: 'empty-state' }, [
        'No review sessions found in this workspace.',
      ]);
    }
    const cards = state.sessions.map((session) => {
      const total = session.itemCount;
      const reviewed = session.reviewedCount;
      const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;
      const progressFill = el('div', { className: 'progress-bar-fill' }, []);
      progressFill.style.width = `${pct}%`;
      const header = el('div', { className: 'session-card-header' }, [
        el('span', { className: 'session-subject' }, [session.subject]),
        session.degraded ? el('span', { className: 'badge badge-danger' }, ['Unreadable']) : null,
      ]);
      const body = el('div', { className: 'progress-bar' }, [progressFill]);
      const meta = el('div', { className: 'session-meta' }, [
        el('span', {}, [`${reviewed}/${total} reviewed`]),
        el('span', {}, [formatTime(session.updatedAt)]),
      ]);
      // Degraded sessions have no readable bundle to open - render a non-interactive card (a
      // `div`, not a `button`) instead of one that posts `openSession` for a session the
      // provider would just reject anyway (see ReviewViewProvider.openSession).
      if (session.degraded) {
        return el('div', { className: 'session-card session-card-degraded' }, [header, body, meta]);
      }
      return el(
        'button',
        {
          className: 'session-card',
          onClick: () =>
            post({
              kind: 'openSession',
              workspaceId: session.workspaceId,
              revisionId: session.revisionId,
            }),
        },
        [header, body, meta],
      );
    });
    return el('div', { className: 'session-list' }, cards);
  }

  // ---- Review screen ----

  /** @param {SerializedBundle} bundle */
  function groupItemsByFile(bundle, reviewItemIds) {
    const itemsById = new Map(bundle.bundle.snapshot.items.map((item) => [item.id, item]));
    /** @type {Map<string, any[]>} */
    const byPath = new Map();
    for (const id of reviewItemIds) {
      const item = itemsById.get(id);
      if (!item) continue;
      const files = byPath.get(item.path) ?? [];
      files.push(item);
      byPath.set(item.path, files);
    }
    return byPath;
  }

  /** @param {SerializedBundle} bundle */
  function fileInsight(bundle, path) {
    const files = bundle.bundle.insights.files || [];
    return files.find((file) => file.path === path);
  }

  /** @param {SerializedBundle} bundle */
  function itemInsight(bundle, reviewItemId) {
    return bundle.bundle.insights.items.find((item) => item.reviewItemId === reviewItemId);
  }

  /**
   * The captured diff hunk backing a review item, or undefined (scope snapshots, whole-file
   * items). Powers the inline `.hunk-diff` body.
   *
   * @param {SerializedBundle} bundle
   */
  function hunkForItem(bundle, item) {
    const snapshot = bundle.bundle.snapshot;
    if (snapshot.kind !== 'diff') return undefined;
    const file = snapshot.files.find((candidate) => candidate.path === item.path);
    if (!file) return undefined;
    return file.hunks.find((hunk) => hunk.reviewItemId === item.id);
  }

  /** @param {SerializedBundle} bundle */
  function renderHunkRow(bundle, item) {
    const reviewed = isReviewed(bundle, item.id);
    const insight = itemInsight(bundle, item.id);
    const progress = bundle.bundle.progress.items[item.id];
    const checkbox = el('input', {
      type: 'checkbox',
      checked: reviewed || undefined,
      onClick: (event) => {
        event.stopPropagation();
        post({
          kind: 'setStatus',
          reviewItemId: item.id,
          status: reviewed ? 'needs-review' : 'reviewed',
        });
      },
    });
    const note = el('textarea', {
      className: 'hunk-note',
      placeholder: 'Leave a note...',
      // Identifies this textarea across a full `render()` rebuild so `restoreFocusedNote` can
      // find the same logical note after `app.innerHTML = ''` destroys and recreates the DOM
      // node - see that function for why this is needed at all.
      'data-review-item-id': item.id,
      onClick: (event) => event.stopPropagation(),
      onBlur: (event) =>
        post({ kind: 'saveNote', reviewItemId: item.id, note: event.target.value }),
    });
    note.value = progress?.note || '';

    const diffButton = el(
      'button',
      {
        className: 'hunk-diff-button',
        title: 'Open diff for this hunk',
        onClick: (event) => {
          event.stopPropagation();
          post({ kind: 'openNativeDiff', path: item.path, reviewItemId: item.id });
        },
      },
      ['diff'],
    );
    const hunk = state.diffVisible ? hunkForItem(bundle, item) : undefined;
    // The jump affordance reuses the existing `openHunk` message (same as the "diff" button and
    // the row click) - it already opens the target hunk's range in the editor with decorations,
    // which is exactly what "jump to the moved-to location" means for this host. The "open in
    // editor" action on an out-of-review excerpt is a plain `openFile` with a destination line.
    //
    // Built for every diff-snapshot hunk item regardless of `state.diffVisible`: removal strips
    // must stay reachable with the diff toggle off, not vanish along with the diff body (see
    // `renderRemovalSummary` below for the collapsed presentation).
    const removalContext =
      bundle.bundle.snapshot.kind === 'diff'
        ? {
            reviewItemId: item.id,
            snapshot: bundle.bundle.snapshot,
            insights: bundle.bundle.insights,
            onJumpToReviewItem: (reviewItemId) => post({ kind: 'openHunk', reviewItemId }),
            onOpenFile: (path, line) => post({ kind: 'openFile', path, line }),
          }
        : undefined;

    return el(
      'div',
      {
        className: 'hunk-row',
        onClick: () => post({ kind: 'openHunk', reviewItemId: item.id }),
      },
      [
        el('div', { className: 'hunk-row-header' }, [
          checkbox,
          el('span', { className: 'hunk-label' }, [item.label]),
          diffButton,
        ]),
        insight ? el('div', { className: 'hunk-description' }, [insight.description]) : null,
        hunk
          ? renderDiffLines(hunk, item.path, removalContext)
          : renderRemovalSummary(removalContext),
        note,
      ],
    );
  }

  /** @param {SerializedBundle} bundle */
  function renderFileRow(bundle, path, items) {
    const expanded = state.expanded.has(path);
    const reviewedCount = items.filter((item) => isReviewed(bundle, item.id)).length;
    const allReviewed = reviewedCount === items.length;
    const noneReviewed = reviewedCount === 0;
    // `drift` lives beside `bundle`, not nested under it - see the SerializedBundle typedef above.
    const drift = bundle.drift[path] || 'clean';

    const checkbox = el('input', {
      type: 'checkbox',
      checked: allReviewed || undefined,
      onClick: (event) => {
        event.stopPropagation();
        const nextStatus = allReviewed ? 'needs-review' : 'reviewed';
        post({
          kind: 'setStatusBatch',
          reviewItemIds: items.map((item) => item.id),
          status: nextStatus,
        });
      },
    });
    checkbox.indeterminate = !allReviewed && !noneReviewed;

    const driftBadge =
      drift === 'clean' ? null : el('span', { className: `badge drift-badge-${drift}` }, [drift]);

    const fileRow = el(
      'div',
      {
        className: 'file-row',
        onClick: () => {
          if (expanded) state.expanded.delete(path);
          else state.expanded.add(path);
          render();
        },
      },
      [
        checkbox,
        el(
          'span',
          {
            className: 'file-path',
            title: 'Open the full file',
            onClick: (event) => {
              event.stopPropagation();
              post({ kind: 'openFile', path });
            },
          },
          [path],
        ),
        el('span', { className: 'file-count' }, [`${reviewedCount}/${items.length}`]),
        driftBadge,
      ],
    );

    const children = [fileRow];
    if (expanded) {
      const insight = fileInsight(bundle, path);
      if (insight)
        children.push(el('div', { className: 'file-description' }, [insight.description]));
      const actions = [
        el('button', { onClick: () => post({ kind: 'openNativeDiff', path }) }, ['Open diff']),
      ];
      if (drift === 'drifted') {
        actions.push(
          el('button', { onClick: () => post({ kind: 'showSnapshot', path }) }, [
            'Show captured snapshot',
          ]),
        );
      }
      children.push(el('div', { className: 'file-actions' }, actions));
      for (const item of items) children.push(renderHunkRow(bundle, item));
    }
    return el('div', {}, children);
  }

  /**
   * @param {SerializedBundle} bundle
   * @param {any} group
   * @param {{index: number, isLastGroup: boolean, nextGroup: any|undefined}} [chapter] Walkthrough
   *   context. Undefined when the revision carries no narrative (`insights.summary` absent) - in
   *   that case rendering is byte-for-byte the same as before storytelling existed.
   */
  function renderGroup(bundle, group, chapter) {
    const byPath = groupItemsByFile(bundle, group.reviewItemIds);
    const fileRows = [];
    for (const [path, items] of byPath) fileRows.push(renderFileRow(bundle, path, items));
    const label = chapter
      ? el('div', { className: 'group-label group-label-chapter' }, [
          el('span', { className: 'chapter-num' }, [String(chapter.index + 1)]),
          el('span', { className: 'chapter-title' }, [group.label]),
        ])
      : el('div', { className: 'group-label' }, [group.label]);
    const intro =
      chapter && group.intro ? el('p', { className: 'chapter-intro' }, [group.intro]) : null;
    const children = [label, intro, ...fileRows];
    if (chapter && !chapter.isLastGroup) {
      const nextGroup = chapter.nextGroup;
      const nextFirstItemId = nextGroup?.reviewItemIds[0];
      children.push(
        el(
          'button',
          {
            className: 'chapter-continue',
            onClick: () => {
              if (nextGroup && nextFirstItemId) {
                sendAdvanceWalkthrough(nextGroup.id, nextFirstItemId);
              }
            },
          },
          [nextGroup ? `Continue to ${nextGroup.label}` : 'Continue'],
        ),
      );
    }
    return el('div', { className: 'group' }, children);
  }

  /** A chapter past the reveal cursor: collapsed, dimmed, title-only. Clicking it advances the
   * walkthrough to the chapter's first item and (via the reveal-floor bump) expands it. */
  function renderLockedChapter(group, index) {
    return el('div', { className: 'group group-locked' }, [
      el(
        'button',
        {
          className: 'group-label group-label-chapter chapter-head-locked',
          onClick: () => {
            const firstItemId = group.reviewItemIds[0];
            if (firstItemId) sendAdvanceWalkthrough(group.id, firstItemId);
          },
        },
        [
          el('span', { className: 'chapter-num' }, [String(index + 1)]),
          el('span', { className: 'chapter-title' }, [group.label]),
        ],
      ),
    ]);
  }

  function renderSummaryCard(summary, chapterCount) {
    const revealAllButton = state.revealAll
      ? null
      : el(
          'button',
          {
            className: 'walkthrough-reveal-all',
            onClick: () => {
              state.revealAll = true;
              render();
            },
          },
          ['Reveal all'],
        );
    return el('div', { className: 'walkthrough-summary' }, [
      el('div', { className: 'walkthrough-summary-header' }, [
        el('span', { className: 'walkthrough-summary-title' }, ['The story of this change']),
        revealAllButton,
      ]),
      el('p', { className: 'walkthrough-summary-text' }, [summary]),
      el('p', { className: 'walkthrough-summary-meta' }, [
        `${chapterCount} chapter${chapterCount === 1 ? '' : 's'}`,
      ]),
    ]);
  }

  function renderBundle() {
    const bundle = state.bundle;
    if (!bundle) return el('div', { className: 'empty-state' }, ['No session loaded.']);
    const groups = bundle.bundle.insights.groups || [];
    if (groups.length === 0) {
      return el('div', { className: 'empty-state' }, [
        'No review items yet - analysis may still be running.',
      ]);
    }
    const summary = bundle.bundle.insights.summary;
    // No summary -> current flat rendering, byte-for-byte: no chapter context, no summary card.
    if (summary === undefined) {
      return el(
        'div',
        { className: 'review-groups' },
        groups.map((group) => renderGroup(bundle, group)),
      );
    }
    const activeReviewItemId = bundle.bundle.progress.activeReviewItemId;
    const revealedCount = state.revealAll
      ? groups.length
      : Math.max(revealedChapterCount(groups, activeReviewItemId), state.revealFloor);
    const groupNodes = groups.map((group, index) =>
      index < revealedCount
        ? renderGroup(bundle, group, {
            index,
            isLastGroup: index === groups.length - 1,
            nextGroup: groups[index + 1],
          })
        : renderLockedChapter(group, index),
    );
    return el('div', { className: 'review-groups' }, [
      renderSummaryCard(summary, groups.length),
      ...groupNodes,
    ]);
  }

  // ---- Shell ----

  function subjectLabel(source) {
    switch (source.kind) {
      case 'pr':
        return `PR #${source.number}`;
      case 'staged':
        return 'Staged changes';
      case 'unstaged':
        return 'Unstaged changes';
      case 'scope':
        return `Scope: ${source.patterns.join(', ')}`;
      default:
        return 'Review';
    }
  }

  function renderToolbar() {
    const back =
      state.screen === 'bundle'
        ? el(
            'button',
            { className: 'icon-button', onClick: () => post({ kind: 'backToSessions' }) },
            ['< Back'],
          )
        : null;
    const title =
      state.screen === 'bundle' && state.bundle
        ? subjectLabel(state.bundle.bundle.workspace.source)
        : 'Reviews';
    const diffToggle =
      state.screen === 'bundle'
        ? el(
            'button',
            {
              className: `icon-button diff-toggle${state.diffVisible ? ' diff-toggle-on' : ''}`,
              title: 'Toggle diff presentation (inline hunk bodies and editor highlights)',
              onClick: () => setDiffVisible(!state.diffVisible),
            },
            [state.diffVisible ? 'Diff: on' : 'Diff: off'],
          )
        : null;
    return el('div', { className: 'toolbar' }, [
      back,
      el('span', { className: 'toolbar-title' }, [title]),
      diffToggle,
    ]);
  }

  /**
   * `render()` rebuilds the entire tree on every message (`app.innerHTML = ''`), which destroys
   * and recreates every DOM node - including whichever `.hunk-note` textarea the user is
   * currently typing in. Two problems follow from that, and this function (paired with the
   * scroll-position capture in `render()`, see `scrollContainer()`) fixes both:
   *
   * 1. A focused textarea that gets destroyed never fires `blur`, so its in-progress edit is
   *    lost - `saveNote` only posts on blur.
   * 2. Even ignoring data loss, losing focus and cursor position on every incoming message
   *    (e.g. another reviewer's edit arriving over the daemon SSE link) makes typing a note
   *    while a session is "live" nearly unusable.
   *
   * We chose "preserve value + selection across the rebuild" over the alternative of "skip
   * re-render entirely while a note is focused, queue it for blur": that alternative risks the
   * queued render being dropped or stale-guarded incorrectly, and would delay legitimate,
   * unrelated UI updates (toolbar, other rows, error banner) for as long as the user is typing.
   * Preserving state is strictly more robust: every render still happens, and only the one
   * textarea's DOM identity is discontinuous, which its own value transfer papers over.
   */
  function captureFocusedNote() {
    const active = document.activeElement;
    if (!active || !app || !app.contains(active) || !active.classList.contains('hunk-note')) {
      return null;
    }
    const textarea = /** @type {HTMLTextAreaElement} */ (active);
    return {
      reviewItemId: textarea.getAttribute('data-review-item-id'),
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
  }

  function restoreFocusedNote(captured) {
    if (!captured || !captured.reviewItemId || !app) return;
    const restored = /** @type {HTMLTextAreaElement | null} */ (
      app.querySelector(`.hunk-note[data-review-item-id="${CSS.escape(captured.reviewItemId)}"]`)
    );
    if (!restored) return;
    restored.value = captured.value;
    restored.focus();
    restored.setSelectionRange(captured.selectionStart, captured.selectionEnd);
  }

  /**
   * The element that actually scrolls this pane.
   *
   * NOT `#app`: its CSS is `display:flex; flex-direction:column; min-height:100vh` with no
   * `overflow`, so it grows past the viewport and the DOCUMENT scrolls around it. Reading or
   * writing `app.scrollTop` is therefore a silent no-op (always 0). We deliberately keep the
   * document as the scroll container rather than turning `#app` into a nested scroller: the
   * webview iframe then keeps VS Code's native scrollbar look and its scroll-into-view
   * behaviour, and no layout rule has to be rewritten.
   *
   * @returns {Element | null}
   */
  function scrollContainer() {
    return document.scrollingElement || document.documentElement;
  }

  function render() {
    if (!app) return;
    const focusedNote = captureFocusedNote();
    const scroller = scrollContainer();
    const scrollTop = scroller ? scroller.scrollTop : 0;
    app.innerHTML = '';
    app.appendChild(renderToolbar());
    if (state.error) {
      app.appendChild(el('div', { className: 'error-banner' }, [state.error]));
    }
    if (state.screen === 'sessions') {
      app.appendChild(renderSessions());
    } else if (state.bundle) {
      app.appendChild(renderBundle());
    }
    // Restore focus BEFORE scroll: `focus()` scrolls its element into view, which would clobber
    // a scroll position restored first. Doing it in this order lets the explicit scroll restore
    // win.
    restoreFocusedNote(focusedNote);
    // Scroll position, like focus, is reset by rebuilding the DOM from scratch - restore it so a
    // background refresh (fs watcher, daemon SSE event, or the check-all/setStatus round trip)
    // doesn't visually jump the reviewer back to the top of a long file list.
    if (scroller) scroller.scrollTop = scrollTop;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.kind) {
      case 'sessions':
        state.screen = 'sessions';
        state.sessions = message.sessions;
        state.error = null;
        render();
        break;
      case 'bundle': {
        // Reset the local reveal state only when the open session (workspace + revision)
        // actually changes - a bundle refresh for the SAME session (e.g. after setStatus, or
        // this pane's own advanceWalkthrough round trip) must not re-lock chapters the reviewer
        // already unlocked.
        const workspaceId = message.bundle.bundle.workspace.id;
        const revisionId = message.bundle.bundle.snapshot.revisionId;
        const sessionKey = `${workspaceId}\0${revisionId}`;
        if (state.walkthroughSessionKey !== sessionKey) {
          state.walkthroughSessionKey = sessionKey;
          state.revealFloor = 0;
          state.revealAll = false;
        }
        state.screen = 'bundle';
        state.bundle = message.bundle;
        state.error = null;
        render();
        break;
      }
      case 'error':
        state.error = message.message;
        render();
        break;
    }
  });

  // A VS Code theme switch re-stamps <body class="vscode-light|vscode-dark">; re-render so the
  // syntax palette follows it.
  new MutationObserver(() => render()).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  render();
  post({ kind: 'ready' });
  // The extension host resets its toggle to `true` on activation; replay the persisted value so
  // editor decorations stay in sync with what this panel shows.
  if (!state.diffVisible) post({ kind: 'setDiffVisible', value: false });
}

// `acquireVsCodeApi` exists only inside a real VS Code webview - guard the bootstrap so this
// module can be imported under vitest + jsdom (see `renderDiffLines`/`renderRemovalStrip` tests)
// without it throwing immediately on import.
if (typeof acquireVsCodeApi === 'function') startWebview();

export { renderDiffLines, renderRemovalStrip, renderRemovalSummary };
