import type { SessionMeta } from 'virtual:synergy/sessions';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/Sidebar';

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  const name = overrides.name ?? 'demo';
  return {
    name,
    specs: ['00-overview.mdx'],
    hasOrchestrator: true,
    phases: [],
    paths: {
      session: `/abs/${name}`,
      spec: { '00-overview.mdx': `/abs/${name}/00-overview.mdx` },
      orchestrator: `/abs/${name}/orchestrator.md`,
      phaseSpec: {},
      phaseOrchestrator: {},
    },
    lastModified: 1000,
    ...overrides,
  };
}

function renderSidebar(
  opts: {
    sessions?: SessionMeta[];
    currentSessionName?: string;
    route?: string;
    onOpenOrchestrator?: (target: 'root' | { phaseSlug: string }) => void;
  } = {},
) {
  const sessions = opts.sessions ?? [makeSession()];
  const currentSessionName = opts.currentSessionName ?? sessions[0]!.name;
  const onOpenOrchestrator = opts.onOpenOrchestrator ?? vi.fn();
  return {
    onOpenOrchestrator,
    ...render(
      <MemoryRouter initialEntries={[opts.route ?? `/s/${currentSessionName}/overview`]}>
        <Sidebar
          sessions={sessions}
          currentSessionName={currentSessionName}
          onOpenOrchestrator={onOpenOrchestrator}
        />
      </MemoryRouter>,
    ),
  };
}

describe('Sidebar', () => {
  it('renders the brand row', () => {
    renderSidebar();
    expect(screen.getByText(/synergy/i)).toBeInTheDocument();
  });

  it('renders only Overview row for a minimal session', () => {
    renderSidebar({
      sessions: [makeSession({ specs: ['00-overview.mdx'], hasOrchestrator: false })],
    });
    expect(screen.getByRole('link', { name: /overview/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /architecture/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /implementation/i })).toBeNull();
  });

  it('renders Architecture and Implementation rows when files exist', () => {
    renderSidebar({
      sessions: [
        makeSession({
          specs: ['00-overview.mdx', '01-architecture.mdx', '02-implementation.mdx'],
          paths: {
            session: '/abs/demo',
            spec: {
              '00-overview.mdx': '/abs/demo/00-overview.mdx',
              '01-architecture.mdx': '/abs/demo/01-architecture.mdx',
              '02-implementation.mdx': '/abs/demo/02-implementation.mdx',
            },
            orchestrator: '/abs/demo/orchestrator.md',
            phaseSpec: {},
            phaseOrchestrator: {},
          },
        }),
      ],
    });
    expect(screen.getByRole('link', { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /architecture/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /implementation/i })).toBeInTheDocument();
  });

  it('renders phases nested under Implementation, with Phase N — title format', () => {
    renderSidebar({
      sessions: [
        makeSession({
          specs: ['00-overview.mdx', '02-implementation.mdx'],
          phases: [
            {
              order: 1,
              slug: 'foundations',
              folder: '01-foundations',
              hasOrchestrator: true,
              title: 'Foundations',
            },
            {
              order: 2,
              slug: 'core',
              folder: '02-core',
              hasOrchestrator: false,
              title: 'Core',
            },
          ],
          paths: {
            session: '/abs/demo',
            spec: {
              '00-overview.mdx': '/abs/demo/00-overview.mdx',
              '02-implementation.mdx': '/abs/demo/02-implementation.mdx',
            },
            orchestrator: '/abs/demo/orchestrator.md',
            phaseSpec: {
              foundations: '/abs/demo/phases/01-foundations/spec.mdx',
              core: '/abs/demo/phases/02-core/spec.mdx',
            },
            phaseOrchestrator: {
              foundations: '/abs/demo/phases/01-foundations/orchestrator.md',
            },
          },
        }),
      ],
      route: '/s/demo/implementation',
    });
    expect(screen.getByRole('link', { name: /Phase 1 — Foundations/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Phase 2 — Core/i })).toBeInTheDocument();
  });

  it('auto-expands phases when on /implementation route', () => {
    renderSidebar({
      sessions: [
        makeSession({
          specs: ['00-overview.mdx', '02-implementation.mdx'],
          phases: [
            {
              order: 1,
              slug: 'foundations',
              folder: '01-foundations',
              hasOrchestrator: false,
              title: 'Foundations',
            },
          ],
          paths: {
            session: '/abs/demo',
            spec: {
              '00-overview.mdx': '/abs/demo/00-overview.mdx',
              '02-implementation.mdx': '/abs/demo/02-implementation.mdx',
            },
            orchestrator: '/abs/demo/orchestrator.md',
            phaseSpec: { foundations: '/abs/demo/phases/01-foundations/spec.mdx' },
            phaseOrchestrator: {},
          },
        }),
      ],
      route: '/s/demo/implementation',
    });
    expect(screen.getByRole('link', { name: /Phase 1 — Foundations/i })).toBeVisible();
  });

  it('auto-expands phases when on a /phases/* route', () => {
    renderSidebar({
      sessions: [
        makeSession({
          specs: ['00-overview.mdx', '02-implementation.mdx'],
          phases: [
            {
              order: 1,
              slug: 'foundations',
              folder: '01-foundations',
              hasOrchestrator: false,
              title: 'Foundations',
            },
          ],
          paths: {
            session: '/abs/demo',
            spec: {
              '00-overview.mdx': '/abs/demo/00-overview.mdx',
              '02-implementation.mdx': '/abs/demo/02-implementation.mdx',
            },
            orchestrator: '/abs/demo/orchestrator.md',
            phaseSpec: { foundations: '/abs/demo/phases/01-foundations/spec.mdx' },
            phaseOrchestrator: {},
          },
        }),
      ],
      route: '/s/demo/phases/foundations',
    });
    expect(screen.getByRole('link', { name: /Phase 1 — Foundations/i })).toBeVisible();
  });

  it('omits the root orchestrator entry when the session has none', () => {
    renderSidebar({
      sessions: [
        makeSession({
          hasOrchestrator: false,
          paths: {
            session: '/abs/demo',
            spec: { '00-overview.mdx': '/abs/demo/00-overview.mdx' },
            phaseSpec: {},
            phaseOrchestrator: {},
          },
        }),
      ],
    });
    expect(screen.queryByRole('button', { name: /^orchestrator$/i })).toBeNull();
  });

  it('renders the root orchestrator entry when the session has one', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /^orchestrator$/i })).toBeInTheDocument();
  });

  it('invokes onOpenOrchestrator with root when clicked', async () => {
    const onOpenOrchestrator = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ onOpenOrchestrator });
    await user.click(screen.getByRole('button', { name: /^orchestrator$/i }));
    expect(onOpenOrchestrator).toHaveBeenCalledWith('root');
  });

  it('lists every session in the dropdown', async () => {
    const sessions = [
      makeSession({ name: 'recent', lastModified: 200 }),
      makeSession({ name: 'old', lastModified: 100 }),
    ];
    const user = userEvent.setup();
    renderSidebar({ sessions, currentSessionName: 'recent' });
    // Dropdown toggle button shows current session name.
    await user.click(screen.getByRole('button', { name: /^session/i }));
    const list = screen.getByRole('list', { name: /sessions/i });
    expect(within(list).getByText('recent')).toBeInTheDocument();
    expect(within(list).getByText('old')).toBeInTheDocument();
  });
});
