export type StatusValue =
  | 'draft'
  | 'proposed'
  | 'in-progress'
  | 'blocked'
  | 'done'
  | 'shipped';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type RiskCategory =
  | 'technical'
  | 'product'
  | 'security'
  | 'performance'
  | 'process'
  | 'scope';

export type ActorRole =
  | 'designer'
  | 'engineer'
  | 'pm'
  | 'reviewer'
  | 'qa'
  | 'sre'
  | 'lead';

export type AgentType = 'sub-agent' | 'agent-team' | 'human';

export type ChartKind =
  | 'flow'
  | 'sequence'
  | 'state'
  | 'class'
  | 'er'
  | 'gantt'
  | 'mindmap'
  | 'architecture';
