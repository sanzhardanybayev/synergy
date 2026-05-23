import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../src/PageHeader';
import { ToastProvider } from '../src/ToastProvider';

function renderHeader(props: React.ComponentProps<typeof PageHeader>) {
  return render(
    <ToastProvider>
      <PageHeader {...props} />
    </ToastProvider>,
  );
}

const baseProps = {
  title: 'Overview',
  relativePath: '00-overview.mdx',
  sessionPath: '/abs/sessions/foo',
  pagePath: '/abs/sessions/foo/00-overview.mdx',
};

describe('PageHeader', () => {
  it('renders the title and relative path', () => {
    renderHeader(baseProps);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('00-overview.mdx')).toBeInTheDocument();
  });

  it('renders three copy buttons when all paths are present', () => {
    renderHeader({
      ...baseProps,
      orchestratorPath: '/abs/sessions/foo/orchestrator.md',
    });
    expect(screen.getByRole('button', { name: /session path/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /current page path/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /orchestrator path/i })).toBeInTheDocument();
  });

  it('omits the orchestrator button when no orchestrator path is given', () => {
    renderHeader(baseProps);
    expect(screen.getByRole('button', { name: /session path/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /current page path/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /orchestrator path/i })).toBeNull();
  });

  it('passes the right values via the title attribute on each button', () => {
    renderHeader({
      ...baseProps,
      orchestratorPath: '/abs/sessions/foo/orchestrator.md',
    });
    expect(
      screen.getByRole('button', { name: /session path/i }),
    ).toHaveAttribute('title', baseProps.sessionPath);
    expect(
      screen.getByRole('button', { name: /current page path/i }),
    ).toHaveAttribute('title', baseProps.pagePath);
    expect(
      screen.getByRole('button', { name: /orchestrator path/i }),
    ).toHaveAttribute('title', '/abs/sessions/foo/orchestrator.md');
  });
});
