import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProgressDto } from '../src/api.js';
import { ProgressDrawer } from '../src/ProgressDrawer.js';

const data: ProgressDto = {
  progress: {
    version: 1,
    overallStatus: 'in-progress',
    resume: { nextPhase: 'cutover', note: 'begin canary 1%' },
    phases: [
      { slug: 'storage', status: 'done' },
      { slug: 'cutover', status: 'in-progress' },
    ],
  },
  derived: { done: 1, total: 2, percent: 50 },
  phaseJournals: { storage: '\n## done — T\ndual-write live\n' },
  globalJournal: '- T: cache TTL 300s\n',
};

describe('ProgressDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ProgressDrawer open={false} data={data} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows derived progress, phases, resume pointer, and global journal when open', () => {
    render(<ProgressDrawer open data={data} onClose={() => {}} />);
    expect(screen.getByText(/1\s*\/\s*2/)).toBeTruthy();
    expect(screen.getByText('storage')).toBeTruthy();
    expect(screen.getByText('cutover')).toBeTruthy();
    expect(screen.getByText(/begin canary 1%/)).toBeTruthy();
    expect(screen.getByText(/cache TTL 300s/)).toBeTruthy();
  });
});
