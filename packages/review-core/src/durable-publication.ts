import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ReviewQuestionGenerationState } from './types.js';

export interface QuestionPublication {
  kind: 'question' | 'generation' | 'answer';
  path: string;
  questionId: string;
  generation?: number;
  state?: ReviewQuestionGenerationState;
}

export interface QuestionPersistenceOptions {
  beforePublish?: (publication: QuestionPublication) => void;
  afterPublish?: (publication: QuestionPublication) => void;
  beforeFileFsync?: (publication: QuestionPublication) => void;
  afterFileFsync?: (publication: QuestionPublication) => void;
  beforeParentDirectoryFsync?: (publication: QuestionPublication) => void;
  afterParentDirectoryFsync?: (publication: QuestionPublication) => void;
  beforeDirectoryFsync?: (publication: QuestionPublication) => void;
  afterDirectoryFsync?: (publication: QuestionPublication) => void;
  link?: (temporary: string, destination: string, publication: QuestionPublication) => void;
  cleanupTemporary?: (temporary: string, publication: QuestionPublication) => void;
}

export class CommittedPublicationError extends Error {
  readonly destination: string;
  readonly expectedBytes: string;

  constructor(destination: string, expectedBytes: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`review artifact was linked but directory fsync failed for ${destination}: ${detail}`);
    this.name = 'CommittedPublicationError';
    this.destination = destination;
    this.expectedBytes = expectedBytes;
  }
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isExactCommittedPublication(error: unknown): boolean {
  if (!(error instanceof CommittedPublicationError)) return false;
  try {
    return readFileSync(error.destination, 'utf8') === error.expectedBytes;
  } catch {
    return false;
  }
}

function fsyncDirectory(
  directory: string,
  before: (() => void) | undefined,
  after: (() => void) | undefined,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, 'r');
    before?.();
    fsyncSync(descriptor);
    after?.();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureDurableDirectory(
  directory: string,
  publication: QuestionPublication,
  options: QuestionPersistenceOptions,
): void {
  mkdirSync(directory, { recursive: true });
  fsyncDirectory(
    dirname(directory),
    () => options.beforeParentDirectoryFsync?.(publication),
    () => options.afterParentDirectoryFsync?.(publication),
  );
}

export function publishExclusiveText(
  path: string,
  raw: string,
  publication: QuestionPublication,
  options: QuestionPersistenceOptions,
  authorize?: () => void,
  validatePath?: () => void,
): void {
  const directory = dirname(path);
  ensureDurableDirectory(directory, publication, options);
  validatePath?.();
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporary, 'wx');
    writeFileSync(fileDescriptor, raw, 'utf8');
    options.beforeFileFsync?.(publication);
    fsyncSync(fileDescriptor);
    options.afterFileFsync?.(publication);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    options.beforePublish?.(publication);
    authorize?.();
    validatePath?.();
    try {
      if (options.link) options.link(temporary, path, publication);
      else linkSync(temporary, path);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV') {
        throw new Error(`hard-link publication is unsupported for review artifact ${path}`);
      }
      throw error;
    }
    try {
      fsyncDirectory(
        directory,
        () => options.beforeDirectoryFsync?.(publication),
        () => options.afterDirectoryFsync?.(publication),
      );
    } catch (error) {
      throw new CommittedPublicationError(path, raw, error);
    }
    options.afterPublish?.(publication);
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    try {
      if (options.cleanupTemporary) options.cleanupTemporary(temporary, publication);
      else rmSync(temporary, { force: true });
    } catch (cleanupError) {
      // Cleanup cannot change the published destination and private temp files are never read.
      void cleanupError;
    }
  }
}

export function publishExclusiveJson(
  path: string,
  value: unknown,
  publication: QuestionPublication,
  options: QuestionPersistenceOptions,
): void {
  publishExclusiveText(path, serializeJson(value), publication, options);
}
