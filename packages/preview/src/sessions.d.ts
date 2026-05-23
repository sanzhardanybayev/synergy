declare module 'virtual:synergy/sessions' {
  import type { ComponentType } from 'react';

  export interface PhaseMeta {
    order: number;
    slug: string;
    folder: string;
    hasOrchestrator: boolean;
    title: string;
  }

  export interface SessionPaths {
    session: string;
    spec: Record<string, string>;
    orchestrator?: string;
    phaseSpec: Record<string, string>;
    phaseOrchestrator: Record<string, string>;
  }

  export interface SessionMeta {
    name: string;
    specs: string[];
    hasOrchestrator: boolean;
    phases: PhaseMeta[];
    paths: SessionPaths;
    lastModified: number;
  }

  type MdxModule = { default: ComponentType };
  type RawModule = { default: string };

  export interface SessionLoaders {
    spec: Record<string, () => Promise<MdxModule>>;
    orchestrator?: () => Promise<RawModule>;
    phaseSpec: Record<string, () => Promise<MdxModule>>;
    phaseOrchestrator: Record<string, () => Promise<RawModule>>;
  }

  export const SESSIONS_DIR: string;
  export const sessions: SessionMeta[];
  export const loaders: Record<string, SessionLoaders>;
}
