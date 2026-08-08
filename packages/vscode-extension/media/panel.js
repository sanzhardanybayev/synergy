// @ts-check
// panel.js - vanilla-DOM webview UI for the Synergy Review pane. No framework: the message
// protocol (see src/panel/messages.ts) is small enough that hand-written DOM updates stay
// readable, and skipping React/Vue keeps the extension bundle tiny.
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
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /**
   * `diffVisible` is the global diff-presentation toggle (inline hunk bodies here, decorations in
   * the editor). It survives webview disposal via `vscode.setState` and is mirrored to the host
   * with a `setDiffVisible` message (on toggle AND on startup, since the host resets to `true`).
   *
   * @type {{screen: 'sessions'|'bundle', sessions: any[], bundle: SerializedBundle|null, error: string|null, expanded: Set<string>, diffVisible: boolean}}
   */
  const state = {
    screen: 'sessions',
    sessions: [],
    bundle: null,
    error: null,
    expanded: new Set(),
    diffVisible: vscode.getState()?.diffVisible !== false,
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

  function renderDiffLines(hunk) {
    const rows = hunk.lines.map((line) => {
      const kindClass =
        line.kind === 'add' ? 'diff-line-add' : line.kind === 'remove' ? 'diff-line-remove' : '';
      const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      return el('div', { className: `diff-line ${kindClass}` }, [
        el('span', { className: 'diff-gutter' }, [
          line.oldLine === null ? '' : String(line.oldLine),
        ]),
        el('span', { className: 'diff-gutter' }, [
          line.newLine === null ? '' : String(line.newLine),
        ]),
        el('span', { className: 'diff-text' }, [`${marker}${line.text}`]),
      ]);
    });
    return el('div', { className: 'hunk-diff' }, rows);
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
        hunk ? renderDiffLines(hunk) : null,
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

  /** @param {SerializedBundle} bundle */
  function renderGroup(bundle, group) {
    const byPath = groupItemsByFile(bundle, group.reviewItemIds);
    const fileRows = [];
    for (const [path, items] of byPath) fileRows.push(renderFileRow(bundle, path, items));
    return el('div', { className: 'group' }, [
      el('div', { className: 'group-label' }, [group.label]),
      ...fileRows,
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
    return el(
      'div',
      { className: 'review-groups' },
      groups.map((group) => renderGroup(bundle, group)),
    );
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
      case 'bundle':
        state.screen = 'bundle';
        state.bundle = message.bundle;
        state.error = null;
        render();
        break;
      case 'error':
        state.error = message.message;
        render();
        break;
    }
  });

  render();
  post({ kind: 'ready' });
  // The extension host resets its toggle to `true` on activation; replay the persisted value so
  // editor decorations stay in sync with what this panel shows.
  if (!state.diffVisible) post({ kind: 'setDiffVisible', value: false });
})();
