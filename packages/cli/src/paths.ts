import { resolve } from 'node:path';

export interface ProjectPaths {
  root: string;
  synergyDir: string;
  sessionsDir: string;
  feedbackDir: string;
  previewPidFile: string;
  previewLogFile: string;
}

export function resolveProjectPaths(root: string = process.cwd()): ProjectPaths {
  const projectRoot = resolve(root);
  const synergyDir = resolve(projectRoot, '.synergy');
  return {
    root: projectRoot,
    synergyDir,
    sessionsDir: resolve(synergyDir, 'sessions'),
    feedbackDir: resolve(synergyDir, 'feedback'),
    previewPidFile: resolve(synergyDir, 'preview.pid'),
    previewLogFile: resolve(synergyDir, 'preview.log'),
  };
}

export const PREVIEW_PORT = 4321;
