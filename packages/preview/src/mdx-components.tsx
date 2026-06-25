/**
 * mdxComponents — the components map for MDXProvider.
 *
 * Maps standard prose HTML elements to EditableBlock instances bound to the
 * appropriate tag. Non-prose elements (pre, code, a, table, img, etc.) are
 * NOT overridden — MDX renders them natively.
 *
 * This map is consumed by <MDXProvider components={mdxComponents}> in
 * SpecPage and PhasePage.
 */

import type React from 'react';
import type { AgentTreeNode } from '@synergy/spec-kit';
import { AgentTreeView } from './AgentTreeView.js';
import { EditableBlock } from './EditableBlock.js';
import { useEditBuffer } from './EditBuffer.js';

// Type that satisfies @mdx-js/react's `Props.components` parameter without
// requiring @types/mdx as a direct devDependency.
type MdxComponentsMap = Record<string, React.ElementType>;

function AgentTreeBound(props: { nodes: AgentTreeNode[] }) {
  const buffer = useEditBuffer();
  return <AgentTreeView nodes={props.nodes} file={buffer.currentFile} />;
}

export const mdxComponents: MdxComponentsMap = {
  AgentTree: (props: { nodes: AgentTreeNode[] }) => <AgentTreeBound {...props} />,
  p: (props: React.HTMLAttributes<HTMLParagraphElement> & Record<string, unknown>) => (
    <EditableBlock
      as="p"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement> & Record<string, unknown>) => (
    <EditableBlock
      as="li"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
  h1: (props: React.HTMLAttributes<HTMLHeadingElement> & Record<string, unknown>) => (
    <EditableBlock
      as="h1"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement> & Record<string, unknown>) => (
    <EditableBlock
      as="h2"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement> & Record<string, unknown>) => (
    <EditableBlock
      as="h3"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
  h4: (props: React.HTMLAttributes<HTMLHeadingElement> & Record<string, unknown>) => (
    <EditableBlock
      as="h4"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
  h5: (props: React.HTMLAttributes<HTMLHeadingElement> & Record<string, unknown>) => (
    <EditableBlock
      as="h5"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
  h6: (props: React.HTMLAttributes<HTMLHeadingElement> & Record<string, unknown>) => (
    <EditableBlock
      as="h6"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
  blockquote: (props: React.HTMLAttributes<HTMLQuoteElement> & Record<string, unknown>) => (
    <EditableBlock
      as="blockquote"
      {...props}
      data-source-line-start={props['data-source-line-start'] as string | undefined}
      data-source-col-start={props['data-source-col-start'] as string | undefined}
      data-source-line-end={props['data-source-line-end'] as string | undefined}
      data-source-col-end={props['data-source-col-end'] as string | undefined}
    />
  ),
};
