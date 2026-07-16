import { z } from 'zod';

export const builderCompletionSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().min(1).max(4_000),
    changedFiles: z.array(z.string().min(1).max(1_000)).max(500),
    commandsRun: z.array(z.string().min(1).max(1_000)).max(100),
    knownLimitations: z.array(z.string().max(2_000)).max(30),
    proposedVerification: z.array(z.string().min(1).max(1_000)).max(30),
  })
  .strict();
export type BuilderCompletion = z.infer<typeof builderCompletionSchema>;

export const reviewFindingSchema = z
  .object({
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    file: z.string().min(1).max(1_000),
    line: z.number().int().positive(),
    title: z.string().min(1).max(300),
    rationale: z.string().min(1).max(4_000),
    failureScenario: z.string().min(1).max(4_000),
    suggestedResolution: z.string().min(1).max(4_000),
  })
  .strict();
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewCompletionSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().min(1).max(4_000),
    findings: z.array(reviewFindingSchema).max(100),
  })
  .strict();
export type ReviewCompletion = z.infer<typeof reviewCompletionSchema>;

export const builderCompletionJsonSchema = {
  type: 'object',
  properties: {
    version: { type: 'number', const: 1 },
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    commandsRun: { type: 'array', items: { type: 'string' } },
    knownLimitations: { type: 'array', items: { type: 'string' } },
    proposedVerification: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'version',
    'summary',
    'changedFiles',
    'commandsRun',
    'knownLimitations',
    'proposedVerification',
  ],
  additionalProperties: false,
} as const;

export const reviewCompletionJsonSchema = {
  type: 'object',
  properties: {
    version: { type: 'number', const: 1 },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
          },
          file: { type: 'string' },
          line: { type: 'number' },
          title: { type: 'string' },
          rationale: { type: 'string' },
          failureScenario: { type: 'string' },
          suggestedResolution: { type: 'string' },
        },
        required: [
          'severity',
          'file',
          'line',
          'title',
          'rationale',
          'failureScenario',
          'suggestedResolution',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['version', 'summary', 'findings'],
  additionalProperties: false,
} as const;
