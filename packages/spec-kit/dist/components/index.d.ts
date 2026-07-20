import * as react_jsx_runtime from 'react/jsx-runtime';
import * as react from 'react';
import { ReactNode } from 'react';

type StatusValue = 'draft' | 'proposed' | 'in-progress' | 'blocked' | 'done' | 'shipped';
type Severity = 'low' | 'medium' | 'high' | 'critical';
type RiskCategory = 'technical' | 'product' | 'security' | 'performance' | 'process' | 'scope';
type ActorRole = 'designer' | 'engineer' | 'pm' | 'reviewer' | 'qa' | 'sre' | 'lead';
type AgentType = 'sub-agent' | 'agent-team' | 'human';
type ChartKind = 'flow' | 'sequence' | 'state' | 'class' | 'er' | 'gantt' | 'mindmap' | 'architecture';
type AgentModel = 'opus' | 'sonnet' | 'haiku';
type AgentEffort = 'low' | 'medium' | 'high' | 'max';

interface StatusProps {
    value: StatusValue;
    note?: string;
    editable?: boolean;
    dirty?: boolean;
    onChange?: (next: StatusValue) => void;
}
declare function Status({ value, note, editable, dirty, onChange }: StatusProps): react_jsx_runtime.JSX.Element;

interface PhaseProps {
    number: number;
    title: string;
    /** Stable slug used to key execution state, e.g. "storage". */
    id?: string;
    /** Authored status badge; overridden by live execution state when present. */
    status?: StatusValue;
    summary?: string;
    estimate?: string;
    editable?: boolean;
    statusDirty?: boolean;
    onStatusChange?: (next: StatusValue) => void;
    children?: ReactNode;
}
declare function Phase({ number, title, id, status, summary, estimate, editable, statusDirty, onStatusChange, children, }: PhaseProps): react_jsx_runtime.JSX.Element;

interface TimelineMilestone {
    label: string;
    /** ISO date or human string. */
    when?: string;
    status?: StatusValue;
    description?: string;
}
interface TimelineProps {
    /** Legacy static milestones. Omit for the phase-driven live form. */
    milestones?: TimelineMilestone[];
    /** Optional caption above the timeline. */
    caption?: string;
    children?: ReactNode;
}
declare function Timeline({ milestones, caption, children }: TimelineProps): react_jsx_runtime.JSX.Element | null;

interface SubSpecProps {
    /** Sibling spec slug, e.g. "01-architecture". */
    slug: string;
    title: string;
    status?: StatusValue;
    /** Short one-line summary. */
    summary?: string;
    children?: ReactNode;
}
declare function SubSpec({ slug, title, status, summary, children }: SubSpecProps): react_jsx_runtime.JSX.Element;

interface CrossRefProps {
    /**
     * Target reference. Format: `<slug>` or `<slug>#<anchor>`.
     * Slug is another spec file in the same session (without extension).
     * Anchor is a slugified heading inside that file.
     */
    to: string;
    /** Optional human label override. Defaults to children, then `to`. */
    label?: string;
    children?: ReactNode;
}
declare function CrossRef({ to, label, children }: CrossRefProps): react_jsx_runtime.JSX.Element;

interface AgentAllocationEntry {
    name: string;
    type: AgentType;
    responsibility: string;
    /** Phases this agent touches — slugs (preferred) or legacy numbers. */
    phases?: (number | string)[];
}
interface AgentAllocationProps {
    context?: string;
    entries: AgentAllocationEntry[];
    children?: ReactNode;
}
declare function AgentAllocation({ context, entries, children }: AgentAllocationProps): react_jsx_runtime.JSX.Element;

interface AgentTreeNode {
    name: string;
    type: 'orchestrator' | 'sub-agent' | 'agent-team';
    /** Display name for team nodes. */
    teamName?: string;
    responsibility?: string;
    /** Per-node model. Does NOT inherit. */
    model?: AgentModel;
    /** Effort; inherited from the nearest ancestor when absent. */
    effort?: AgentEffort;
    count?: number;
    /** Child nodes. Recurses for tree traversal. */
    subAgents?: AgentTreeNode[];
}
interface FlatAgentNode {
    node: AgentTreeNode;
    depth: number;
    parentName: string | null;
    resolvedEffort: AgentEffort | null;
    resolvedModel: AgentModel | null;
}
declare function flattenAgentTree(nodes: AgentTreeNode[]): FlatAgentNode[];
declare function resolveNodeEffort(name: string, nodes: AgentTreeNode[]): AgentEffort | null;
declare function collectAgentNames(nodes: AgentTreeNode[]): string[];

/**
 * Live edit controls a host (e.g. the Synergy preview) supplies so an AgentTree
 * authored in MDX becomes interactive — model/effort dropdowns + Save/Discard —
 * regardless of whether the MDX `import`ed `AgentTree` or received it via the
 * MDXProvider. This is the mechanism that makes editability immune to import
 * shadowing.
 */
interface AgentTreeControls {
    /** The current (possibly dirty) tree to render in place of the authored nodes. */
    nodes: AgentTreeNode[];
    dirty: boolean;
    onModelChange: (name: string, model: AgentModel) => void;
    /** effort === null means "clear override, inherit from ancestor". */
    onEffortChange: (name: string, effort: AgentEffort | null) => void;
    onSave: () => void;
    onDiscard: () => void;
}
/**
 * A factory: given an AgentTree's authored nodes, returns live edit controls, or
 * `null` when editing is unavailable (e.g. no active file). The context default
 * is `null` → read-only, so a static/standalone render needs no provider. The
 * preview supplies a factory wired to its edit buffer.
 */
declare const AgentTreeControlsContext: react.Context<((authored: AgentTreeNode[]) => AgentTreeControls | null) | null>;
interface AgentTreeProps {
    nodes: AgentTreeNode[];
    context?: string;
    editable?: boolean;
    dirty?: boolean;
    /** effort === null means "clear override, inherit from ancestor". */
    onEffortChange?: (name: string, effort: AgentEffort | null) => void;
    onModelChange?: (name: string, model: AgentModel) => void;
    children?: ReactNode;
}
declare function AgentTree({ nodes, context, editable, dirty, onEffortChange, onModelChange, children, }: AgentTreeProps): react_jsx_runtime.JSX.Element;

interface TeamMember {
    name: string;
    role: ActorRole;
    /** Optional handle, e.g. github username. */
    handle?: string;
}
interface TeamProps {
    name: string;
    members: TeamMember[];
    /** What this team is responsible for. */
    mission?: string;
    children?: ReactNode;
}
declare function Team({ name, members, mission, children }: TeamProps): react_jsx_runtime.JSX.Element;

interface ReviewerProps {
    name: string;
    role: ActorRole;
    /** Which areas they sign off on. */
    scope: string;
    handle?: string;
    children?: ReactNode;
}
declare function Reviewer({ name, role, scope, handle, children }: ReviewerProps): react_jsx_runtime.JSX.Element;

interface OpenQuestionProps {
    /** Short identifier, e.g. "Q1". Used for cross-refs. */
    id?: string;
    question: string;
    /** Who needs to answer. */
    owner?: string;
    /** When this needs to be resolved. */
    resolveBy?: string;
    /** Body — what's blocked, what's been considered. */
    children?: ReactNode;
}
declare function OpenQuestion({ id, question, owner, resolveBy, children }: OpenQuestionProps): react_jsx_runtime.JSX.Element;

interface RiskProps {
    /** Short identifier, e.g. "R1". */
    id?: string;
    title: string;
    severity: Severity;
    category?: RiskCategory;
    /** What mitigates this. */
    mitigation?: string;
    children?: ReactNode;
}
declare function Risk({ id, title, severity, category, mitigation, children }: RiskProps): react_jsx_runtime.JSX.Element;

interface MockupProps {
    /** Path to image relative to the session's `assets/` folder, or absolute URL. */
    src: string;
    alt: string;
    caption?: string;
    /** Optional max width in px or CSS unit. */
    maxWidth?: string;
    children?: ReactNode;
}
declare function Mockup({ src, alt, caption, maxWidth, children }: MockupProps): react_jsx_runtime.JSX.Element;

interface ChartProps {
    /**
     * Diagram type. Drives the Mermaid prelude. If the source already begins
     * with a Mermaid directive (e.g. `graph TD`, `sequenceDiagram`), `kind` is
     * informational only.
     */
    kind?: ChartKind;
    /**
     * Mermaid source. Prefer placing it as children for multi-line diagrams.
     */
    source?: string;
    /** Optional caption shown under the chart. */
    caption?: string;
    children?: ReactNode;
}
declare function Chart(props: ChartProps): react_jsx_runtime.JSX.Element;

/** Live execution view for a single phase, keyed by phase id/slug. */
interface ExecutionPhaseView {
    status?: StatusValue;
    /** Most recent journal finding, shown as an inline peek under the phase. */
    latestFinding?: string;
}
/** One ordered step in the phase-driven timeline / right rail. */
interface ExecutionRosterEntry {
    number: number;
    slug: string;
    title: string;
    status: StatusValue;
}
interface ExecutionStateView {
    phases: Record<string, ExecutionPhaseView>;
    /** Ordered phase roster (from phase folders + live status). */
    roster?: ExecutionRosterEntry[];
    /** Derived rollup matching the roster. */
    derived?: {
        done: number;
        total: number;
        percent: number;
    };
}
/** Consumed by <Phase>/<Timeline> to overlay live status. Defaults to empty (no overlay). */
declare function useExecutionState(): ExecutionStateView;
declare function ExecutionStateProvider({ value, children, }: {
    value: ExecutionStateView;
    children: ReactNode;
}): react_jsx_runtime.JSX.Element;

export { type ActorRole, AgentAllocation, type AgentAllocationEntry, type AgentAllocationProps, AgentTree, type AgentTreeControls, AgentTreeControlsContext, type AgentTreeNode, type AgentTreeProps, type AgentType, Chart, type ChartKind, type ChartProps, CrossRef, type CrossRefProps, type ExecutionPhaseView, type ExecutionRosterEntry, ExecutionStateProvider, type ExecutionStateView, type FlatAgentNode, Mockup, type MockupProps, OpenQuestion, type OpenQuestionProps, Phase, type PhaseProps, Reviewer, type ReviewerProps, Risk, type RiskCategory, type RiskProps, type Severity, Status, type StatusProps, type StatusValue, SubSpec, type SubSpecProps, Team, type TeamMember, type TeamProps, Timeline, type TimelineMilestone, type TimelineProps, collectAgentNames, flattenAgentTree, resolveNodeEffort, useExecutionState };
