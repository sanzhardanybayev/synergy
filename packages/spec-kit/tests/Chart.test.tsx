import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mermaid is dynamically imported by Chart. Mock it so we control the exact SVG
// string the component parses — the bug lives in how that string is parsed, not
// in Mermaid itself.
const renderMock = vi.fn();
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: (id: string, src: string) => renderMock(id, src),
  },
}));

import { Chart, __clearChartCache } from '../src/components/Chart.js';

// The render cache is module-level, so reset it between tests for isolation.
beforeEach(() => {
  __clearChartCache();
  renderMock.mockReset();
});

describe('Chart — SVG attachment', () => {
  it('renders an <svg> for single-line labels', async () => {
    renderMock.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>',
    });
    const { container } = render(<Chart kind="flow" source="graph LR; A-->B" />);
    await waitFor(() => {
      expect(container.querySelector('.sk-chart__svg svg')).not.toBeNull();
    });
    expect(container.querySelector('.sk-chart__error')).toBeNull();
  });

  it('renders multi-line labels (Mermaid HTML <foreignObject> with unclosed <br>) without crashing', async () => {
    // Mermaid 10+ emits HTML5 inside <foreignObject> for any label with a line
    // break — note the unclosed <br>, which is invalid XML.
    renderMock.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>line one<br>line two</p></foreignObject></svg>',
    });
    const { container } = render(
      <Chart kind="flow" source={'graph LR\n  A[line one<br/>line two] --> B[ok]'} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.sk-chart__svg svg')).not.toBeNull();
    });

    // The page must not be left holding a parsererror node, and no error block.
    expect(container.querySelector('parsererror')).toBeNull();
    expect(container.querySelector('.sk-chart__error')).toBeNull();
    expect(container.querySelector('.sk-chart__svg p')?.textContent).toContain('line two');
  });

  it('strips <script> elements smuggled into the rendered SVG', async () => {
    renderMock.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>x</text></svg>',
    });
    const { container } = render(<Chart kind="flow" source="graph LR; A-->B" />);
    await waitFor(() => {
      expect(container.querySelector('.sk-chart__svg svg')).not.toBeNull();
    });
    expect(container.querySelector('.sk-chart__svg script')).toBeNull();
  });
});

describe('Chart — render cache', () => {
  it('renders identical sources only once across remounts', async () => {
    renderMock.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>cached</text></svg>',
    });
    const src = 'graph TD; X-->Y';

    const first = render(<Chart kind="flow" source={src} />);
    await waitFor(() => {
      expect(first.container.querySelector('.sk-chart__svg svg')).not.toBeNull();
    });
    first.unmount();

    const second = render(<Chart kind="flow" source={src} />);
    await waitFor(() => {
      expect(second.container.querySelector('.sk-chart__svg svg')).not.toBeNull();
    });

    // Two mounts, one underlying mermaid.render() — the cache served the remount.
    const callsForSrc = renderMock.mock.calls.filter(([, s]) => s === src).length;
    expect(callsForSrc).toBe(1);
  });

  it('defers rendering until the chart intersects the viewport', async () => {
    renderMock.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>lazy</text></svg>',
    });

    // jsdom has no IntersectionObserver, so install a controllable one. Its callback
    // is captured on observe() and only fired when we choose — simulating a scroll.
    let fire: (() => void) | null = null;
    class MockIO {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        fire = () =>
          this.cb(
            [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = MockIO as unknown as typeof IntersectionObserver;
    try {
      const { container } = render(<Chart kind="flow" source="graph TD; L-->M" />);
      // Off-screen: nothing rendered, mermaid.render() not called.
      expect(renderMock).not.toHaveBeenCalled();
      expect(container.querySelector('.sk-chart__svg svg')).toBeNull();

      // Scroll into view → render fires.
      act(() => {
        fire?.();
      });
      await waitFor(() => {
        expect(container.querySelector('.sk-chart__svg svg')).not.toBeNull();
      });
      expect(renderMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it('does not cache failures — a later mount retries', async () => {
    renderMock.mockRejectedValueOnce(new Error('boom'));
    const src = 'graph TD; F-->G';

    const first = render(<Chart kind="flow" source={src} />);
    await waitFor(() => {
      expect(first.container.querySelector('.sk-chart__error')).not.toBeNull();
    });
    first.unmount();

    renderMock.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>recovered</text></svg>',
    });
    const second = render(<Chart kind="flow" source={src} />);
    await waitFor(() => {
      expect(second.container.querySelector('.sk-chart__svg svg')).not.toBeNull();
    });
  });
});
