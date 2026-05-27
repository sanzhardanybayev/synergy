/** JSON Schema for .state/progress.json — compiled by @synergy/validator's ajv. */
export const progressJsonSchema = {
  type: 'object',
  required: ['version', 'phases'],
  additionalProperties: true,
  properties: {
    version: { const: 1 },
    overallStatus: {
      enum: ['draft', 'proposed', 'in-progress', 'blocked', 'done', 'shipped'],
    },
    resume: {
      type: 'object',
      properties: { nextPhase: { type: 'string' }, note: { type: 'string' } },
    },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'status'],
        properties: {
          slug: { type: 'string' },
          status: {
            enum: ['draft', 'proposed', 'in-progress', 'blocked', 'done', 'shipped'],
          },
          startedAt: { type: 'string' },
          completedAt: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
    },
  },
} as const;
