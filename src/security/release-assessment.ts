import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../persistence/database.js';

const controlSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  evidence: z.string().min(1),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
});

export const releaseSecurityInputSchema = z.object({
  commitSha: z.string().regex(/^[a-f0-9]{7,64}$/),
  controls: z.array(controlSchema).min(1),
  vulnerabilities: z.array(
    z.object({
      id: z.string().min(1),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      package: z.string().min(1),
      remediation: z.string().min(1),
    }),
  ),
  residualRisks: z.array(
    z.object({
      id: z.string().min(1),
      severity: z.enum(['MEDIUM', 'LOW']),
      rationale: z.string().min(1),
      approvedBy: z.string().min(1).optional(),
    }),
  ),
});

export type ReleaseSecurityInput = z.infer<typeof releaseSecurityInputSchema>;

export interface SecurityFinding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
}

export function assessReleaseSecurity(input: ReleaseSecurityInput): {
  status: 'PASS' | 'FAIL' | 'APPROVAL_REQUIRED';
  findings: SecurityFinding[];
} {
  const parsed = releaseSecurityInputSchema.parse(input);
  const findings: SecurityFinding[] = [
    ...parsed.controls
      .filter((control) => !control.passed)
      .map((control) => ({
        id: control.id,
        severity: control.severity,
        message: `Security control failed: ${control.evidence}`,
      })),
    ...parsed.vulnerabilities.map((vulnerability) => ({
      id: vulnerability.id,
      severity: vulnerability.severity,
      message: `${vulnerability.package}: ${vulnerability.remediation}`,
    })),
  ];
  const blocking = findings.some((finding) =>
    ['CRITICAL', 'HIGH'].includes(finding.severity),
  );
  if (blocking) return { status: 'FAIL', findings };
  const unapprovedRisk = parsed.residualRisks.some((risk) => !risk.approvedBy);
  return {
    status: unapprovedRisk ? 'APPROVAL_REQUIRED' : 'PASS',
    findings,
  };
}

const secretPattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_|ghp_[A-Za-z0-9]{20,}|(?:OPENAI|CODEX|GITHUB|TELEGRAM)[_A-Z]*\s*[=:]\s*[^\s]+)/i;

const forbiddenPathPattern =
  /(?:^|\/)(?:\.git|\.env(?:\.|$)|node_modules|coverage|dist)(?:\/|$)|\.(?:pem|key)$/i;

export function assertPushContentSafe(diff: string, files: string[]): void {
  if (files.length === 0) throw new Error('Final diff is empty');
  if (files.some((file) => forbiddenPathPattern.test(file))) {
    throw new Error('Final diff contains a forbidden path');
  }
  if (secretPattern.test(diff)) {
    throw new Error('Final diff contains a possible secret');
  }
}

export class SecurityAssessmentService {
  constructor(private readonly database: Database) {}

  async record(input: ReleaseSecurityInput): Promise<{
    assessmentId: string;
    status: 'PASS' | 'FAIL' | 'APPROVAL_REQUIRED';
  }> {
    const parsed = releaseSecurityInputSchema.parse(input);
    const result = assessReleaseSecurity(parsed);
    const assessmentId = randomUUID();
    await this.database.query(
      `INSERT INTO security_assessments
        (id, commit_sha, controls, findings, residual_risks, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        assessmentId,
        parsed.commitSha,
        JSON.stringify(parsed.controls),
        JSON.stringify(result.findings),
        JSON.stringify(parsed.residualRisks),
        result.status,
      ],
    );
    return { assessmentId, status: result.status };
  }
}
