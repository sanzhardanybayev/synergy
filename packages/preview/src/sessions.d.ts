declare module 'virtual:synergy/sessions' {
  export interface SessionMeta {
    name: string;
    specs: string[];
    hasOrchestrator: boolean;
    lastModified: number;
  }
  export const SESSIONS_DIR: string;
  export const sessions: SessionMeta[];
  export const loaders: Record<
    string,
    Record<string, () => Promise<{ default: React.ComponentType } | { default: string }>>
  >;
}
