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

  /** @type {{screen: 'sessions'|'bundle', sessions: any[], bundle: SerializedBundle|null, error: string|null, expanded: Set<string>}} */
  const state = {
    screen: 'sessions',
    sessions: [],
    bundle: null,
    error: null,
    expanded: new Set(),
  };

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
        [
          el('div', { className: 'session-card-header' }, [
            el('span', { className: 'session-subject' }, [session.subject]),
            session.degraded
              ? el('span', { className: 'badge badge-danger' }, ['Unreadable'])
              : null,
          ]),
          el('div', { className: 'progress-bar' }, [progressFill]),
          el('div', { className: 'session-meta' }, [
            el('span', {}, [`${reviewed}/${total} reviewed`]),
            el('span', {}, [formatTime(session.updatedAt)]),
          ]),
        ],
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
      onClick: (event) => event.stopPropagation(),
      onBlur: (event) =>
        post({ kind: 'saveNote', reviewItemId: item.id, note: event.target.value }),
    });
    note.value = progress?.note || '';

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
        ]),
        insight ? el('div', { className: 'hunk-description' }, [insight.description]) : null,
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
        for (const item of items)
          post({ kind: 'setStatus', reviewItemId: item.id, status: nextStatus });
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
        el('span', { className: 'file-path' }, [path]),
        el('span', { className: 'file-count' }, [`${reviewedCount}/${items.length}`]),
        driftBadge,
      ],
    );

    const children = [fileRow];
    if (expanded) {
      const insight = fileInsight(bundle, path);
      if (insight)
        children.push(el('div', { className: 'file-description' }, [insight.description]));
      if (drift === 'drifted') {
        children.push(
          el('div', { className: 'file-actions' }, [
            el('button', { onClick: () => post({ kind: 'openNativeDiff', path }) }, [
              'Open native diff',
            ]),
            el('button', { onClick: () => post({ kind: 'showSnapshot', path }) }, [
              'Show captured snapshot',
            ]),
          ]),
        );
      }
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
    return el('div', { className: 'toolbar' }, [
      back,
      el('span', { className: 'toolbar-title' }, [title]),
    ]);
  }

  function render() {
    if (!app) return;
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
})();
