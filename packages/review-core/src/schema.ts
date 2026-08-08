import Ajv, { type ValidateFunction } from 'ajv';
import { SAFE_SEGMENT, assertSafeReviewSegment } from './ids.js';
import { findDuplicateReviewItemId } from './review-item-identity.js';
import type {
  ReviewAnswer,
  ReviewInsights,
  ReviewProgress,
  ReviewQuestion,
  ReviewQuestionEnvelope,
  ReviewQuestionGeneration,
  ReviewSnapshot,
  ReviewWorkspace,
} from './types.js';

const string = { type: 'string' } as const;
const nonEmptyString = { type: 'string', minLength: 1 } as const;
const timestamp = { type: 'string', minLength: 1 } as const;
const safeSegment = { type: 'string', pattern: SAFE_SEGMENT.source } as const;
const rangeSchema = {
  type: 'object',
  required: ['start', 'end'],
  additionalProperties: false,
  properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } },
} as const;
const sourceSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'number', 'url', 'baseSha', 'headSha'],
      additionalProperties: false,
      properties: {
        kind: { const: 'pr' },
        number: { type: 'integer', minimum: 1 },
        url: nonEmptyString,
        baseSha: nonEmptyString,
        headSha: nonEmptyString,
      },
    },
    {
      type: 'object',
      required: ['kind', 'headSha'],
      additionalProperties: false,
      properties: { kind: { const: 'staged' }, headSha: nonEmptyString },
    },
    {
      type: 'object',
      required: ['kind', 'headSha'],
      additionalProperties: false,
      properties: { kind: { const: 'unstaged' }, headSha: nonEmptyString },
    },
    {
      type: 'object',
      required: ['kind', 'patterns', 'headSha'],
      additionalProperties: false,
      properties: {
        kind: { const: 'scope' },
        patterns: { type: 'array', minItems: 1, items: nonEmptyString },
        headSha: nonEmptyString,
      },
    },
  ],
} as const;
const itemSchema = {
  type: 'object',
  required: ['id', 'kind', 'path', 'label', 'range', 'contentHash', 'locationHash'],
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    kind: { enum: ['hunk', 'code-section', 'file'] },
    path: nonEmptyString,
    label: nonEmptyString,
    range: rangeSchema,
    contentHash: nonEmptyString,
    locationHash: nonEmptyString,
  },
} as const;

export const reviewWorkspaceSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'id',
    'repository',
    'source',
    'currentRevisionId',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: nonEmptyString,
    repository: {
      type: 'object',
      required: ['root', 'name'],
      additionalProperties: false,
      properties: { root: nonEmptyString, name: nonEmptyString, remoteUrl: string },
    },
    source: sourceSchema,
    currentRevisionId: nonEmptyString,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;

const diffLineSchema = {
  type: 'object',
  required: ['kind', 'text', 'oldLine', 'newLine'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['context', 'add', 'remove'] },
    text: string,
    oldLine: { type: ['integer', 'null'], minimum: 1 },
    newLine: { type: ['integer', 'null'], minimum: 1 },
    noNewlineAtEnd: { type: 'boolean' },
  },
} as const;
const diffHunkSchema = {
  type: 'object',
  required: [
    'reviewItemId',
    'reviewItemContentHash',
    'reviewItemLocationHash',
    'header',
    'oldStart',
    'oldLines',
    'newStart',
    'newLines',
    'lines',
  ],
  additionalProperties: false,
  properties: {
    reviewItemId: nonEmptyString,
    reviewItemContentHash: nonEmptyString,
    reviewItemLocationHash: nonEmptyString,
    header: nonEmptyString,
    oldStart: { type: 'integer', minimum: 0 },
    oldLines: { type: 'integer', minimum: 0 },
    newStart: { type: 'integer', minimum: 0 },
    newLines: { type: 'integer', minimum: 0 },
    lines: { type: 'array', items: diffLineSchema },
  },
} as const;
const diffFileSchema = {
  type: 'object',
  required: ['path', 'status', 'additions', 'deletions', 'binary', 'hunks'],
  additionalProperties: false,
  properties: {
    reviewItemId: nonEmptyString,
    reviewItemContentHash: nonEmptyString,
    reviewItemLocationHash: nonEmptyString,
    path: nonEmptyString,
    previousPath: nonEmptyString,
    oldMode: nonEmptyString,
    newMode: nonEmptyString,
    binaryPatchHash: nonEmptyString,
    status: { enum: ['added', 'deleted', 'modified', 'renamed', 'copied', 'binary'] },
    additions: { type: 'integer', minimum: 0 },
    deletions: { type: 'integer', minimum: 0 },
    binary: { type: 'boolean' },
    hunks: { type: 'array', items: diffHunkSchema },
  },
} as const;
const sourceFileSchema = {
  type: 'object',
  required: ['path', 'lines', 'binary'],
  additionalProperties: false,
  properties: {
    path: nonEmptyString,
    binary: { type: 'boolean' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'text'],
        additionalProperties: false,
        properties: { number: { type: 'integer', minimum: 1 }, text: string },
      },
    },
  },
} as const;
const scopeLineRowSchema = {
  type: 'object',
  required: ['id', 'kind', 'line', 'text'],
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    kind: { const: 'scope' },
    line: { type: 'integer', minimum: 1 },
    text: string,
  },
} as const;
const diffLineRowSchema = {
  type: 'object',
  required: ['id', 'kind', 'oldLine', 'newLine', 'text'],
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    kind: { enum: ['context', 'add', 'remove'] },
    oldLine: { type: ['integer', 'null'], minimum: 1 },
    newLine: { type: ['integer', 'null'], minimum: 1 },
    text: string,
    noNewlineAtEnd: { type: 'boolean' },
  },
} as const;
const itemContextSchema = {
  type: 'object',
  required: ['item', 'rows'],
  additionalProperties: false,
  properties: {
    item: itemSchema,
    rows: { type: 'array', minItems: 1, items: { oneOf: [scopeLineRowSchema, diffLineRowSchema] } },
  },
} as const;
const lineSelectionSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'selectedLineIds'],
      additionalProperties: false,
      properties: {
        kind: { const: 'diff' },
        selectedLineIds: { type: 'array', minItems: 1, uniqueItems: true, items: nonEmptyString },
      },
    },
    {
      type: 'object',
      required: ['kind', 'selectedLineIds'],
      additionalProperties: false,
      properties: {
        kind: { const: 'scope' },
        selectedLineIds: { type: 'array', minItems: 1, uniqueItems: true, items: nonEmptyString },
      },
    },
  ],
} as const;
const snapshotBaseProperties = {
  schemaVersion: { const: 1 },
  revisionId: nonEmptyString,
  predecessorRevisionId: safeSegment,
  source: sourceSchema,
  fingerprint: nonEmptyString,
  createdAt: timestamp,
  items: { type: 'array', items: itemSchema },
} as const;

export const reviewSnapshotSchema = {
  oneOf: [
    {
      type: 'object',
      required: [
        'schemaVersion',
        'revisionId',
        'source',
        'fingerprint',
        'createdAt',
        'items',
        'kind',
        'files',
      ],
      additionalProperties: false,
      properties: {
        ...snapshotBaseProperties,
        kind: { const: 'diff' },
        files: { type: 'array', items: diffFileSchema },
      },
    },
    {
      type: 'object',
      required: [
        'schemaVersion',
        'revisionId',
        'source',
        'fingerprint',
        'createdAt',
        'items',
        'kind',
        'files',
      ],
      additionalProperties: false,
      properties: {
        ...snapshotBaseProperties,
        kind: { const: 'scope' },
        files: { type: 'array', items: sourceFileSchema },
      },
    },
  ],
} as const;

const fileInsightSchema = {
  type: 'object',
  required: ['path', 'description', 'confidence'],
  additionalProperties: false,
  properties: {
    path: nonEmptyString,
    description: nonEmptyString,
    confidence: { enum: ['high', 'medium', 'low'] },
  },
} as const;

export const reviewInsightsSchema = {
  type: 'object',
  required: ['schemaVersion', 'revisionId', 'groups', 'items'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    revisionId: nonEmptyString,
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'label', 'reviewItemIds'],
        additionalProperties: false,
        properties: {
          id: nonEmptyString,
          label: nonEmptyString,
          reviewItemIds: { type: 'array', items: nonEmptyString },
        },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['reviewItemId', 'description', 'confidence', 'evidencePaths'],
        additionalProperties: false,
        properties: {
          reviewItemId: nonEmptyString,
          description: nonEmptyString,
          confidence: { enum: ['high', 'medium', 'low'] },
          evidencePaths: { type: 'array', items: nonEmptyString },
        },
      },
    },
    files: { type: 'array', items: fileInsightSchema },
  },
} as const;

const itemProgressSchema = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { enum: ['needs-review', 'reviewed', 'carried-forward', 'stale'] },
    note: string,
    reviewedAt: timestamp,
    inheritedFrom: {
      type: 'object',
      required: ['revisionId', 'reviewItemId'],
      additionalProperties: false,
      properties: { revisionId: nonEmptyString, reviewItemId: nonEmptyString },
    },
  },
} as const;

export const reviewProgressSchema = {
  type: 'object',
  required: ['schemaVersion', 'updatedAt', 'items'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    updatedAt: timestamp,
    items: { type: 'object', additionalProperties: itemProgressSchema },
    activeGroupId: nonEmptyString,
    activeFile: nonEmptyString,
    activeReviewItemId: nonEmptyString,
  },
} as const;

const claimSchema = {
  type: 'object',
  required: ['listenerId', 'token', 'claimedAt', 'expiresAt'],
  additionalProperties: false,
  properties: {
    listenerId: nonEmptyString,
    token: safeSegment,
    claimedAt: timestamp,
    expiresAt: timestamp,
  },
} as const;

const questionEnvelopeProperties = {
  schemaVersion: { const: 1 },
  id: nonEmptyString,
  workspaceId: nonEmptyString,
  revisionId: nonEmptyString,
  path: nonEmptyString,
  reviewItemId: nonEmptyString,
  selection: lineSelectionSchema,
  itemContext: itemContextSchema,
  description: string,
  body: nonEmptyString,
  createdAt: timestamp,
} as const;

export const reviewQuestionEnvelopeSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'revisionId',
    'path',
    'reviewItemId',
    'selection',
    'itemContext',
    'description',
    'body',
    'createdAt',
  ],
  additionalProperties: false,
  properties: questionEnvelopeProperties,
} as const;

export const reviewQuestionSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'revisionId',
    'path',
    'reviewItemId',
    'selection',
    'itemContext',
    'description',
    'body',
    'createdAt',
    'generation',
    'status',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: nonEmptyString,
    workspaceId: nonEmptyString,
    revisionId: nonEmptyString,
    path: nonEmptyString,
    reviewItemId: nonEmptyString,
    selection: lineSelectionSchema,
    itemContext: itemContextSchema,
    description: string,
    body: nonEmptyString,
    createdAt: timestamp,
    generation: { type: 'integer', minimum: 0 },
    status: { enum: ['queued', 'processing', 'answered', 'failed', 'stale'] },
    claim: claimSchema,
    failureMessage: string,
  },
} as const;

export const reviewQuestionGenerationSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'questionId',
    'workspaceId',
    'revisionId',
    'generation',
    'predecessorGeneration',
    'predecessorHash',
    'envelopeHash',
    'state',
    'publishedAt',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    questionId: nonEmptyString,
    workspaceId: nonEmptyString,
    revisionId: nonEmptyString,
    generation: { type: 'integer', minimum: 0 },
    predecessorGeneration: { type: ['integer', 'null'], minimum: 0 },
    predecessorHash: { type: ['string', 'null'], minLength: 1 },
    envelopeHash: nonEmptyString,
    state: { enum: ['queued', 'claimed', 'answer-pending', 'answered', 'failed', 'stale'] },
    publishedAt: timestamp,
    claim: claimSchema,
    answer: {
      type: 'object',
      required: ['id', 'listenerId', 'bodyHash', 'createdAt'],
      additionalProperties: false,
      properties: {
        id: safeSegment,
        listenerId: nonEmptyString,
        bodyHash: nonEmptyString,
        createdAt: timestamp,
      },
    },
    failureMessage: nonEmptyString,
  },
} as const;

export const reviewAnswerSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'id',
    'questionId',
    'workspaceId',
    'revisionId',
    'listenerId',
    'body',
    'createdAt',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: nonEmptyString,
    questionId: nonEmptyString,
    workspaceId: nonEmptyString,
    revisionId: nonEmptyString,
    listenerId: nonEmptyString,
    body: nonEmptyString,
    createdAt: timestamp,
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = {
  workspace: ajv.compile(reviewWorkspaceSchema),
  snapshot: ajv.compile(reviewSnapshotSchema),
  insights: ajv.compile(reviewInsightsSchema),
  progress: ajv.compile(reviewProgressSchema),
  question: ajv.compile(reviewQuestionSchema),
  questionEnvelope: ajv.compile(reviewQuestionEnvelopeSchema),
  questionGeneration: ajv.compile(reviewQuestionGenerationSchema),
  answer: ajv.compile(reviewAnswerSchema),
};

function assertSchema<T>(
  value: unknown,
  validate: ValidateFunction,
  artifact: string,
): asserts value is T {
  if (validate(value)) return;
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || '(root)'} ${error.message ?? 'invalid'}`)
    .join('; ');
  throw new Error(`invalid review ${artifact}: ${details}`);
}

function assertReviewRange(range: { start: number; end: number }): void {
  if (range.start > range.end) {
    throw new Error('review range start must not exceed end');
  }
}

export function assertReviewWorkspace(value: unknown): asserts value is ReviewWorkspace {
  assertSchema<ReviewWorkspace>(value, validators.workspace, 'workspace');
}

export function assertReviewSnapshot(value: unknown): asserts value is ReviewSnapshot {
  assertSchema<ReviewSnapshot>(value, validators.snapshot, 'snapshot');
  const duplicateItemId = findDuplicateReviewItemId(value.items);
  if (duplicateItemId) throw new Error(`duplicate review item id: ${duplicateItemId}`);
  if (value.kind === 'diff' && value.files.some((file) => file.binary && !file.binaryPatchHash)) {
    throw new Error('binary diff file must retain its canonical patch hash');
  }
  for (const item of value.items) {
    assertReviewRange(item.range);
  }
}

export function assertReviewInsights(value: unknown): asserts value is ReviewInsights {
  assertSchema<ReviewInsights>(value, validators.insights, 'insights');
}

export function assertReviewProgress(value: unknown): asserts value is ReviewProgress {
  assertSchema<ReviewProgress>(value, validators.progress, 'progress');
}

export function assertReviewQuestion(value: unknown): asserts value is ReviewQuestion {
  assertSchema<ReviewQuestion>(value, validators.question, 'question');
}

export function assertReviewQuestionEnvelope(
  value: unknown,
): asserts value is ReviewQuestionEnvelope {
  assertSchema<ReviewQuestionEnvelope>(value, validators.questionEnvelope, 'question envelope');
}

export function assertReviewQuestionGeneration(
  value: unknown,
): asserts value is ReviewQuestionGeneration {
  assertSchema<ReviewQuestionGeneration>(
    value,
    validators.questionGeneration,
    'question generation',
  );
  if (value.generation === 0) {
    if (value.predecessorGeneration !== null || value.predecessorHash !== null) {
      throw new Error('initial review question generation must not have a predecessor');
    }
  } else if (
    value.predecessorGeneration !== value.generation - 1 ||
    value.predecessorHash === null
  ) {
    throw new Error('review question generation must reference its immediate predecessor');
  }
  const needsClaim = value.state === 'claimed' || value.state === 'answer-pending';
  if (needsClaim !== (value.claim !== undefined)) {
    throw new Error(`review question generation state ${value.state} has invalid claim data`);
  }
  const needsAnswer = value.state === 'answer-pending' || value.state === 'answered';
  if (needsAnswer !== (value.answer !== undefined)) {
    throw new Error(`review question generation state ${value.state} has invalid answer data`);
  }
  if (value.state === 'answer-pending' && value.answer?.listenerId !== value.claim?.listenerId) {
    throw new Error('review question pending answer owner does not match its claim');
  }
  if (
    value.state === 'answer-pending' &&
    value.answer?.id !== `answer-${value.questionId}-${value.claim?.token}`
  ) {
    throw new Error('review question generation answer id is not token-scoped deterministic');
  }
  const needsFailure = value.state === 'failed';
  if (needsFailure !== (value.failureMessage !== undefined)) {
    throw new Error(`review question generation state ${value.state} has invalid failure data`);
  }
  if (value.claim) assertSafeReviewSegment(value.claim.token, 'claim token');
  if (value.answer) assertSafeReviewSegment(value.answer.id, 'answer');
}

export function assertReviewAnswer(value: unknown): asserts value is ReviewAnswer {
  assertSchema<ReviewAnswer>(value, validators.answer, 'answer');
  assertSafeReviewSegment(value.id, 'answer');
}
