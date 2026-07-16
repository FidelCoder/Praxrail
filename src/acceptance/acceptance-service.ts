import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../persistence/database.js';

export const RELEASE_ACCEPTANCE_SCENARIOS = [
  'CLEAR_REQUEST_TO_REVIEWED_PR',
  'AMBIGUOUS_REQUEST_CLARIFICATION',
  'UNAUTHORIZED_AND_REPLAYED_TELEGRAM',
  'REPOSITORY_WRITE_SERIALIZATION',
  'BUILDER_CRASH_RECOVERY',
  'BOUNDED_VERIFICATION_REPAIR',
  'REVIEW_FINDING_REPAIR_AND_REREVIEW',
  'NO_PROGRESS_TERMINATION',
  'MODEL_BUDGET_EXHAUSTION',
  'GITHUB_WEBHOOK_REPLAY',
  'MANUAL_MERGE_RECONCILIATION',
  'DAILY_REPORT_LEDGER_RECONCILIATION',
  'PROMPT_INJECTION_CONTAINMENT',
  'LIFECYCLE_RESTART_CONVERGENCE',
] as const;

export type AcceptanceScenarioId =
  (typeof RELEASE_ACCEPTANCE_SCENARIOS)[number];

const scenarioResultSchema = z.object({
  id: z.enum(RELEASE_ACCEPTANCE_SCENARIOS),
  status: z.enum(['PASSED', 'FAILED', 'OPERATOR_GATED']),
  evidenceIds: z.array(z.string().min(1)).max(100),
  notes: z.string().max(2_000).default(''),
});

export const acceptanceRunSchema = z
  .object({
    environment: z.string().min(1).max(100),
    passNumber: z.union([z.literal(1), z.literal(2)]),
    scenarios: z
      .array(scenarioResultSchema)
      .length(RELEASE_ACCEPTANCE_SCENARIOS.length),
    ownerSignoff: z.string().min(1).max(500).optional(),
  })
  .superRefine((run, context) => {
    const ids = new Set(run.scenarios.map((scenario) => scenario.id));
    for (const scenario of RELEASE_ACCEPTANCE_SCENARIOS) {
      if (!ids.has(scenario)) {
        context.addIssue({
          code: 'custom',
          path: ['scenarios'],
          message: `Acceptance scenario ${scenario} is missing`,
        });
      }
    }
  });

export type AcceptanceRunInput = z.infer<typeof acceptanceRunSchema>;

export function acceptanceStatus(
  input: AcceptanceRunInput,
): 'PASSED' | 'FAILED' | 'OPERATOR_GATED' {
  const run = acceptanceRunSchema.parse(input);
  if (run.scenarios.some((scenario) => scenario.status === 'FAILED')) {
    return 'FAILED';
  }
  if (
    !run.ownerSignoff ||
    run.scenarios.some((scenario) => scenario.status === 'OPERATOR_GATED')
  ) {
    return 'OPERATOR_GATED';
  }
  return 'PASSED';
}

export class AcceptanceService {
  constructor(private readonly database: Database) {}

  async record(input: AcceptanceRunInput): Promise<{
    runId: string;
    status: 'PASSED' | 'FAILED' | 'OPERATOR_GATED';
  }> {
    const run = acceptanceRunSchema.parse(input);
    const status = acceptanceStatus(run);
    const runId = randomUUID();
    await this.database.query(
      `INSERT INTO acceptance_runs
        (id, environment, pass_number, scenarios, status, evidence,
         owner_signoff, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        runId,
        run.environment,
        run.passNumber,
        JSON.stringify(run.scenarios),
        status,
        {
          evidenceIds: run.scenarios.flatMap(
            (scenario) => scenario.evidenceIds,
          ),
        },
        run.ownerSignoff ?? null,
      ],
    );
    return { runId, status };
  }
}
