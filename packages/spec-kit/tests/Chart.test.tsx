import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

import { Chart } from '../src/components/Chart.js';

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
