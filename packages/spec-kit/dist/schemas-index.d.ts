type ComponentName = 'Status' | 'Phase' | 'Timeline' | 'SubSpec' | 'CrossRef' | 'AgentAllocation' | 'Team' | 'Reviewer' | 'OpenQuestion' | 'Risk' | 'Mockup' | 'Chart' | 'AgentTree';
declare const schemas: Record<ComponentName, unknown>;
declare const componentNames: ComponentName[];

export { type ComponentName, componentNames, schemas };
