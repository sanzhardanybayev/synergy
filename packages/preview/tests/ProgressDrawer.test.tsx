import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressDrawer } from '../src/ProgressDrawer.js';
import type { ProgressDto } from '../src/api.js';

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
  roster: [],
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

const rosterData: ProgressDto = {
  progress: {
    version: 1,
    overallStatus: 'in-progress',
    resume: {},
    phases: [{ slug: 'storage', status: 'done' }],
  },
  derived: { done: 1, total: 2, percent: 50 },
  roster: [
    { number: 1, slug: 'storage', title: 'Storage layer', status: 'done' },
    { number: 2, slug: 'cutover', title: 'Cutover', status: 'proposed' },
  ],
  phaseJournals: {},
  globalJournal: null,
};

describe('ProgressDrawer roster', () => {
  it('renders roster titles and the derived rollup', () => {
    render(<ProgressDrawer open data={rosterData} onClose={() => {}} />);
    expect(screen.getByText('Storage layer')).toBeTruthy();
    expect(screen.getByText('Cutover')).toBeTruthy();
    expect(screen.getByText(/1 \/ 2 phases done \(50%\)/)).toBeTruthy();
  });
});
