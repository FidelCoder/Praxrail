import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  ApiActor,
  ChannelIdentity,
  ChannelPreference,
  DiagnosticReport,
  Project,
  Repository,
  SupportBundle,
  TaskDetail,
  TaskEvidence,
  TaskStatus,
} from '@praxrail/core';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
} from '../domain/errors.js';
import type { Database } from '../persistence/database.js';
import type { OutboxService } from '../services/outbox-service.js';
import type { TaskService } from '../services/task-service.js';

const TERMINAL_STATES: readonly TaskStatus[] = [
  'VERIFIED',
  'CANCELLED',
  'ABANDONED',
  'SUPERSEDED',
];

function iso(value: Date): string {
  return value.toISOString();
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(message);
  return row;
}

function requireOwner(actor: ApiActor): void {
  if (!['OWNER', 'OPERATOR'].includes(actor.role)) {
    throw new AuthorizationError('Owner or operator authority is required');
  }
}

function assertProjectScope(actor: ApiActor, projectId: string): void {
  if (
    actor.role !== 'OPERATOR' &&
    !(actor.role === 'OWNER' && actor.projectIds.length === 0) &&
    !actor.projectIds.includes(projectId)
  ) {
    throw new AuthorizationError('Project is outside the actor scope');
  }
}

function destinationHint(channel: 'EMAIL' | 'TELEGRAM', value: string): string {
  if (channel === 'EMAIL') {
    const [local = '', domain = ''] = value.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return value.length <= 4 ? '****' : `***${value.slice(-4)}`;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  status: Project['status'];
  created_at: Date;
  updated_at: Date;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface RepositoryRow {
  id: string;
  project_id: string;
  full_name: string;
  clone_url: string;
  default_branch: string;
  worker_profile: string;
  onboarding_status: Repository['status'];
  enabled: boolean;
  onboarding_report: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

function mapRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    projectId: row.project_id,
    fullName: row.full_name,
    cloneUrl: row.clone_url,
    defaultBranch: row.default_branch,
    workerProfile: row.worker_profile,
    status: row.enabled ? 'APPROVED' : row.onboarding_status,
    enabled: row.enabled,
    inspection: row.onboarding_report,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface TaskRow {
  id: string;
  task_key: string;
  project_id: string | null;
  repository_id: string | null;
  title: string;
  problem: string;
  desired_outcome: string;
  status: TaskStatus;
  priority: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  contract: Record<string, unknown> | null;
  version: number;
  paused_at: Date | null;
  blocked_reason: string | null;
  budget_usd: string | null;
  spent_usd: string;
  current_attempt: number;
  maximum_attempts: number | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function requiredAction(row: TaskRow): string {
  if (row.archived_at) return 'Archived; no action required';
  if (row.paused_at) return 'Resume the task when work may continue';
  if (row.blocked_reason) return row.blocked_reason;
  const actions: Partial<Record<TaskStatus, string>> = {
    INBOX: 'Clarify and refine the task contract',
    REFINING: 'Complete the task contract',
    BLOCKED: 'Resolve the blocking condition',
    READY: 'Await a capable worker',
    BUILDING: 'Monitor the active worker',
    FAILED: 'Inspect failure evidence and retry or cancel',
    REVIEWING: 'Await independent review',
    CHANGES_REQUESTED: 'Address open review findings',
    CI: 'Await deterministic checks',
    PR_READY: 'Publish or request approval',
    AWAITING_APPROVAL: 'Approve or reject the pending action',
    MERGED: 'Verify the merged change',
    DEPLOYED: 'Verify the deployment',
  };
  return actions[row.status] ?? 'No action required';
}

function mapTask(row: TaskRow): TaskDetail {
  return {
    id: row.id,
    taskKey: row.task_key,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    title: row.title,
    problem: row.problem,
    desiredOutcome: row.desired_outcome,
    status: row.status,
    priority: row.priority,
    risk: row.risk,
    contract: row.contract,
    version: row.version,
    paused: row.paused_at !== null,
    blockedReason: row.blocked_reason,
    budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
    spentUsd: Number(row.spent_usd),
    currentAttempt: row.current_attempt,
    maximumAttempts: row.maximum_attempts,
    archivedAt: row.archived_at ? iso(row.archived_at) : null,
    requiredAction: requiredAction(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const TASK_COLUMNS = `
  task.id, task.task_key, task.project_id, task.repository_id, task.title,
  task.problem, task.desired_outcome, task.status, task.priority, task.risk,
  task.contract, task.version, task.paused_at, task.blocked_reason,
  task.budget_usd::text, task.current_attempt, task.maximum_attempts,
  task.archived_at, task.created_at, task.updated_at,
  COALESCE((SELECT sum(cost.amount_usd) FROM cost_entries AS cost
    WHERE cost.task_id = task.id), 0)::text AS spent_usd
`;

interface ChannelRow {
  id: string;
  channel: 'EMAIL' | 'TELEGRAM';
  project_id: string | null;
  role: ChannelIdentity['role'];
  destination_hint: string;
  status: ChannelIdentity['status'];
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ConnectorRow {
  channel: 'EMAIL' | 'TELEGRAM';
  enabled: boolean;
  credentialStatus: 'configured' | null;
  configuration: Record<string, unknown>;
  failureCount: number;
  circuitOpenUntil: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  updatedAt: Date;
}

function mapConnector(row: ConnectorRow): Record<string, unknown> {
  return {
    channel: row.channel,
    enabled: row.enabled,
    credentialStatus: row.credentialStatus,
    configuration: row.configuration,
    failureCount: row.failureCount,
    circuitOpenUntil: row.circuitOpenUntil ? iso(row.circuitOpenUntil) : null,
    lastSuccessAt: row.lastSuccessAt ? iso(row.lastSuccessAt) : null,
    lastFailureAt: row.lastFailureAt ? iso(row.lastFailureAt) : null,
    updatedAt: iso(row.updatedAt),
  };
}

function mapChannel(row: ChannelRow): ChannelIdentity {
  return {
    id: row.id,
    channel: row.channel,
    projectId: row.project_id,
    role: row.role,
    destinationHint: row.destination_hint,
    status: row.status,
    verifiedAt: row.verified_at ? iso(row.verified_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class ProductService {
  constructor(
    private readonly database: Database,
    private readonly tasks: TaskService,
    private readonly outbox: OutboxService,
  ) {}

  async listProjects(actor: ApiActor): Promise<Project[]> {
    const result = await this.database.query<ProjectRow>(
      `SELECT id, slug, name, status, created_at, updated_at FROM projects
       WHERE ($1::boolean OR id = ANY($2::uuid[]))
       ORDER BY name`,
      [
        actor.role === 'OPERATOR' ||
          (actor.role === 'OWNER' && actor.projectIds.length === 0),
        actor.projectIds,
      ],
    );
    return result.rows.map(mapProject);
  }

  async getProject(reference: string, actor: ApiActor): Promise<Project> {
    const result = await this.database.query<ProjectRow>(
      `SELECT id, slug, name, status, created_at, updated_at FROM projects
       WHERE id::text = $1 OR slug = lower($1)`,
      [reference],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError(`Project ${reference} was not found`);
    assertProjectScope(actor, row.id);
    return mapProject(row);
  }

  async createProject(
    input: { slug: string; name: string; dryRun?: boolean },
    actor: ApiActor,
  ): Promise<Project & { dryRun?: boolean }> {
    requireOwner(actor);
    const slug = input.slug.trim().toLowerCase();
    const name = input.name.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      throw new RangeError('Project slug is invalid');
    }
    if (name.length < 2 || name.length > 120) {
      throw new RangeError('Project name must contain 2 to 120 characters');
    }
    const id = randomUUID();
    const now = new Date();
    if (input.dryRun) {
      return {
        id,
        slug,
        name,
        status: 'ACTIVE',
        createdAt: iso(now),
        updatedAt: iso(now),
        dryRun: true,
      };
    }
    const result = await this.database.query<ProjectRow>(
      `INSERT INTO projects (id, slug, name) VALUES ($1, $2, $3)
       RETURNING id, slug, name, status, created_at, updated_at`,
      [id, slug, name],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Project creation returned no record');
    return mapProject(row);
  }

  async updateProject(
    reference: string,
    input: {
      name?: string | undefined;
      status?: Project['status'] | undefined;
      dryRun?: boolean;
    },
    actor: ApiActor,
  ): Promise<Project & { dryRun?: boolean }> {
    requireOwner(actor);
    const current = await this.getProject(reference, actor);
    const next = {
      ...current,
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (input.dryRun) return { ...next, dryRun: true };
    const result = await this.database.query<ProjectRow>(
      `UPDATE projects SET name = $2, status = $3, updated_at = now()
       WHERE id = $1
       RETURNING id, slug, name, status, created_at, updated_at`,
      [current.id, next.name, next.status],
    );
    return mapProject(
      requireRow(result.rows[0], 'Project update returned no record'),
    );
  }

  async listRepositories(
    actor: ApiActor,
    projectId?: string,
  ): Promise<Repository[]> {
    if (projectId) assertProjectScope(actor, projectId);
    const privileged =
      actor.role === 'OPERATOR' ||
      (actor.role === 'OWNER' && actor.projectIds.length === 0);
    const result = await this.database.query<RepositoryRow>(
      `SELECT id, project_id, full_name, clone_url, default_branch,
              worker_profile, onboarding_status, enabled, onboarding_report,
              created_at, updated_at
       FROM repositories
       WHERE ($1::uuid IS NULL OR project_id = $1)
         AND ($2::boolean OR project_id = ANY($3::uuid[]))
       ORDER BY full_name`,
      [projectId ?? null, privileged, actor.projectIds],
    );
    return result.rows.map(mapRepository);
  }

  async getRepository(reference: string, actor: ApiActor): Promise<Repository> {
    const result = await this.database.query<RepositoryRow>(
      `SELECT id, project_id, full_name, clone_url, default_branch,
              worker_profile, onboarding_status, enabled, onboarding_report,
              created_at, updated_at
       FROM repositories
       WHERE id::text = $1 OR lower(full_name) = lower($1)`,
      [reference],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError(`Repository ${reference} was not found`);
    assertProjectScope(actor, row.project_id);
    return mapRepository(row);
  }

  async addRepository(
    input: {
      projectId: string;
      fullName: string;
      cloneUrl: string;
      defaultBranch: string;
      workerProfile: string;
      githubRepositoryId?: number | undefined;
      githubInstallationId?: number | undefined;
      mirrorPath?: string | undefined;
      verificationCommands?: string[] | undefined;
      policy?: Record<string, unknown> | undefined;
      dryRun?: boolean | undefined;
    },
    actor: ApiActor,
  ): Promise<Repository & { dryRun?: boolean }> {
    requireOwner(actor);
    assertProjectScope(actor, input.projectId);
    const fullName = input.fullName.toLowerCase();
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(fullName)) {
      throw new RangeError('Repository must use owner/name identity');
    }
    const expectedUrl = `https://github.com/${fullName}.git`;
    if (input.cloneUrl !== expectedUrl) {
      throw new ConflictError(`Clone URL must be ${expectedUrl}`);
    }
    const id = randomUUID();
    const now = new Date();
    if (input.dryRun) {
      return {
        id,
        projectId: input.projectId,
        fullName,
        cloneUrl: input.cloneUrl,
        defaultBranch: input.defaultBranch,
        workerProfile: input.workerProfile,
        status: 'PENDING',
        enabled: false,
        inspection: null,
        createdAt: iso(now),
        updatedAt: iso(now),
        dryRun: true,
      };
    }
    const result = await this.database.query<RepositoryRow>(
      `INSERT INTO repositories
        (id, project_id, github_repository_id, full_name, clone_url,
         default_branch, github_installation_id, worker_profile,
         verification_commands, policy, enabled, mirror_path,
         onboarding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, 'PENDING')
       RETURNING id, project_id, full_name, clone_url, default_branch,
         worker_profile, onboarding_status, enabled, onboarding_report,
         created_at, updated_at`,
      [
        id,
        input.projectId,
        input.githubRepositoryId ?? null,
        fullName,
        input.cloneUrl,
        input.defaultBranch,
        input.githubInstallationId ?? null,
        input.workerProfile,
        JSON.stringify(input.verificationCommands ?? []),
        input.policy ?? {},
        input.mirrorPath ?? null,
      ],
    );
    return mapRepository(
      requireRow(result.rows[0], 'Repository creation returned no record'),
    );
  }

  async inspectRepository(
    reference: string,
    actor: ApiActor,
  ): Promise<{
    repository: Repository;
    safeForWrites: boolean;
    findings: string[];
    remediation: string[];
  }> {
    requireOwner(actor);
    const repository = await this.getRepository(reference, actor);
    const result = await this.database.query<{
      verification_commands: unknown;
      policy: Record<string, unknown>;
      mirror_path: string | null;
      report_id: string | null;
      safe_for_writes: boolean | null;
      findings: string[] | null;
    }>(
      `SELECT repository.verification_commands, repository.policy,
              repository.mirror_path, report.id AS report_id,
              report.safe_for_writes, report.findings
       FROM repositories AS repository
       LEFT JOIN LATERAL (
         SELECT id, safe_for_writes, findings
         FROM repository_onboarding_reports
         WHERE repository_id = repository.id
         ORDER BY inspected_at DESC LIMIT 1
       ) AS report ON true
       WHERE repository.id = $1`,
      [repository.id],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Repository was not found');
    const findings = row.report_id
      ? (row.findings ?? [])
      : [
          'No checkout-backed onboarding report exists',
          ...(Array.isArray(row.verification_commands) &&
          row.verification_commands.length > 0
            ? []
            : ['Verification commands are not configured']),
          ...(row.mirror_path ? [] : ['Managed mirror path is not configured']),
        ];
    return {
      repository,
      safeForWrites: row.safe_for_writes === true && findings.length === 0,
      findings,
      remediation:
        findings.length === 0
          ? []
          : [
              'Run checkout-backed inspection on the managed worker',
              'Resolve every finding and inspect again before approval',
            ],
    };
  }

  async setRepositoryStatus(
    reference: string,
    action: 'approve' | 'disable' | 'remove',
    actor: ApiActor,
    dryRun = false,
  ): Promise<Repository | { removed: true; dryRun?: boolean }> {
    requireOwner(actor);
    const current = await this.getRepository(reference, actor);
    if (action === 'remove') {
      const usage = await this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tasks WHERE repository_id = $1',
        [current.id],
      );
      if (usage.rows[0]?.count !== '0') {
        throw new ConflictError(
          'Repository with task history must be disabled, not removed',
        );
      }
      if (!dryRun) {
        await this.database.query('DELETE FROM repositories WHERE id = $1', [
          current.id,
        ]);
      }
      return { removed: true, ...(dryRun ? { dryRun: true } : {}) };
    }
    if (action === 'approve') {
      const inspection = await this.inspectRepository(current.id, actor);
      if (!inspection.safeForWrites) {
        throw new ConflictError(
          'Repository cannot be approved until inspection passes',
        );
      }
    }
    if (dryRun) {
      return {
        ...current,
        status: action === 'approve' ? 'APPROVED' : 'DISABLED',
        enabled: action === 'approve',
      };
    }
    const result = await this.database.query<RepositoryRow>(
      `UPDATE repositories SET enabled = $2, onboarding_status = $3,
         approved_at = CASE WHEN $2 THEN now() ELSE approved_at END,
         approved_by = CASE WHEN $2 THEN $4 ELSE approved_by END,
         updated_at = now()
       WHERE id = $1
       RETURNING id, project_id, full_name, clone_url, default_branch,
         worker_profile, onboarding_status, enabled, onboarding_report,
         created_at, updated_at`,
      [
        current.id,
        action === 'approve',
        action === 'approve' ? 'APPROVED' : 'DISABLED',
        actor.actorId,
      ],
    );
    return mapRepository(
      requireRow(result.rows[0], 'Repository status update returned no record'),
    );
  }

  async listTasks(
    actor: ApiActor,
    filters: {
      projectId?: string | undefined;
      repositoryId?: string | undefined;
      status?: TaskStatus | undefined;
      limit?: number | undefined;
      includeArchived?: boolean | undefined;
    } = {},
  ): Promise<TaskDetail[]> {
    if (filters.projectId) assertProjectScope(actor, filters.projectId);
    const privileged =
      actor.role === 'OPERATOR' ||
      (actor.role === 'OWNER' && actor.projectIds.length === 0);
    const result = await this.database.query<TaskRow>(
      `SELECT ${TASK_COLUMNS}
       FROM tasks AS task
       WHERE ($1::uuid IS NULL OR task.project_id = $1)
         AND ($2::uuid IS NULL OR task.repository_id = $2)
         AND ($3::text IS NULL OR task.status = $3)
         AND ($4::boolean OR task.archived_at IS NULL)
         AND ($5::boolean OR task.project_id = ANY($6::uuid[]))
       ORDER BY task.priority DESC, task.updated_at DESC
       LIMIT $7`,
      [
        filters.projectId ?? null,
        filters.repositoryId ?? null,
        filters.status ?? null,
        filters.includeArchived ?? false,
        privileged,
        actor.projectIds,
        Math.max(1, Math.min(filters.limit ?? 50, 500)),
      ],
    );
    return result.rows.map(mapTask);
  }

  async getTask(reference: string, actor: ApiActor): Promise<TaskDetail> {
    const result = await this.database.query<TaskRow>(
      `SELECT ${TASK_COLUMNS}
       FROM tasks AS task
       WHERE task.id::text = $1 OR upper(task.task_key) = upper($1)`,
      [reference],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError(`Task ${reference} was not found`);
    if (row.project_id) assertProjectScope(actor, row.project_id);
    return mapTask(row);
  }

  async createTask(
    input: {
      title: string;
      request: string;
      projectId: string;
      repositoryId: string;
      priority?: number | undefined;
      budgetUsd?: number | undefined;
      dryRun?: boolean | undefined;
    },
    actor: ApiActor,
  ): Promise<TaskDetail & { dryRun?: boolean }> {
    assertProjectScope(actor, input.projectId);
    const repository = await this.getRepository(input.repositoryId, actor);
    if (repository.projectId !== input.projectId) {
      throw new ConflictError('Repository belongs to another project');
    }
    if (!repository.enabled || repository.status !== 'APPROVED') {
      throw new ConflictError('Repository is not approved for writes');
    }
    const priority = input.priority ?? 50;
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new RangeError('Priority must be between 0 and 100');
    }
    if (input.dryRun) {
      const now = new Date().toISOString();
      return {
        id: randomUUID(),
        taskKey: 'PXR-DRY-RUN',
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        title: input.title,
        problem: input.request,
        desiredOutcome: input.request,
        status: 'INBOX',
        priority,
        risk: null,
        contract: null,
        version: 1,
        paused: false,
        blockedReason: null,
        budgetUsd: input.budgetUsd ?? null,
        spentUsd: 0,
        currentAttempt: 0,
        maximumAttempts: null,
        archivedAt: null,
        requiredAction: 'Clarify and refine the task contract',
        createdAt: now,
        updatedAt: now,
        dryRun: true,
      };
    }
    const id = randomUUID();
    await this.database.transaction(async (client) => {
      const sequence = await client.query<{ value: string }>(
        "SELECT nextval('task_key_sequence')::text AS value",
      );
      const value = sequence.rows[0]?.value;
      if (!value) throw new Error('Task sequence returned no value');
      const taskKey = `PXR-${value.padStart(4, '0')}`;
      await client.query(
        `INSERT INTO tasks
          (id, task_key, project_id, repository_id, title, problem,
           desired_outcome, status, priority, budget_usd, created_by_type,
           created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'INBOX', $7, $8, $9, $10)`,
        [
          id,
          taskKey,
          input.projectId,
          input.repositoryId,
          input.title.trim(),
          input.request.trim(),
          priority,
          input.budgetUsd ?? null,
          actor.role,
          actor.actorId,
        ],
      );
      await client.query(
        `INSERT INTO task_events
          (task_id, event_type, actor_type, actor_id, correlation_id, payload)
         VALUES ($1, 'TASK_CREATED', $2, $3, $4, $5)`,
        [
          id,
          actor.role,
          actor.actorId,
          randomUUID(),
          { source: 'CLI', repositoryId: input.repositoryId },
        ],
      );
    });
    return this.getTask(id, actor);
  }

  async controlTask(
    reference: string,
    input: {
      action:
        | 'clarify'
        | 'prioritize'
        | 'pause'
        | 'resume'
        | 'cancel'
        | 'retry'
        | 'abandon'
        | 'archive';
      reason?: string | undefined;
      priority?: number | undefined;
    },
    actor: ApiActor,
    correlationId: string = randomUUID(),
  ): Promise<TaskDetail> {
    const task = await this.getTask(reference, actor);
    if (input.action === 'prioritize') {
      await this.tasks.setPriority(
        task.id,
        input.priority ?? -1,
        actor.role,
        actor.actorId,
        correlationId,
      );
      return this.getTask(task.id, actor);
    }
    if (input.action === 'pause' || input.action === 'resume') {
      await this.tasks.setPaused(
        task.id,
        input.action === 'pause',
        actor.role,
        actor.actorId,
        correlationId,
      );
      return this.getTask(task.id, actor);
    }
    if (input.action === 'archive') {
      if (!TERMINAL_STATES.includes(task.status)) {
        throw new ConflictError('Only terminal tasks can be archived');
      }
      if (!input.reason?.trim()) {
        throw new ConflictError('Archiving requires a reason');
      }
      await this.database.query(
        'UPDATE tasks SET archived_at = now(), updated_at = now() WHERE id = $1',
        [task.id],
      );
      return this.getTask(task.id, actor);
    }
    if (input.action === 'clarify') {
      if (!input.reason?.trim()) {
        throw new ConflictError('Clarification text is required');
      }
      await this.database.query(
        `INSERT INTO task_events
          (task_id, event_type, actor_type, actor_id, correlation_id, payload)
         VALUES ($1, 'TASK_CLARIFIED', $2, $3, $4, $5)`,
        [
          task.id,
          actor.role,
          actor.actorId,
          correlationId,
          { answer: input.reason.slice(0, 10_000) },
        ],
      );
      return task;
    }
    if (!input.reason?.trim()) {
      throw new ConflictError(`${input.action} requires a reason`);
    }
    const target: TaskStatus =
      input.action === 'cancel'
        ? 'CANCELLED'
        : input.action === 'abandon'
          ? 'ABANDONED'
          : 'READY';
    if (input.action === 'retry' && task.status !== 'FAILED') {
      throw new ConflictError('Only failed tasks can be retried');
    }
    if (
      input.action === 'abandon' &&
      !['BLOCKED', 'FAILED', 'CANCELLED'].includes(task.status)
    ) {
      throw new ConflictError(
        'Only blocked, failed, or cancelled tasks can be abandoned',
      );
    }
    await this.tasks.transition({
      taskId: task.id,
      expectedStatus: task.status,
      expectedVersion: task.version,
      to: target,
      actorRole: actor.role,
      actorId: actor.actorId,
      correlationId,
      eventPayload: { reason: input.reason },
    });
    return this.getTask(task.id, actor);
  }

  async taskEvidence(
    reference: string,
    actor: ApiActor,
  ): Promise<TaskEvidence> {
    const task = await this.getTask(reference, actor);
    const [attempts, costs, verification, findings, review, pull, git] =
      await Promise.all([
        this.database.query<Record<string, unknown>>(
          `SELECT id, attempt_number AS "attemptNumber", status, worker_id AS "workerId",
                  failure_class AS "failureClass", diff_digest AS "diffDigest",
                  cost_usd::text AS "costUsd", started_at AS "startedAt",
                  completed_at AS "completedAt"
           FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number`,
          [task.id],
        ),
        this.database.query<Record<string, unknown>>(
          `SELECT provider, model, input_tokens AS "inputTokens",
                  output_tokens AS "outputTokens", amount_usd::text AS "amountUsd",
                  occurred_at AS "occurredAt"
           FROM cost_entries WHERE task_id = $1 ORDER BY occurred_at`,
          [task.id],
        ),
        this.database.query<Record<string, unknown>>(
          `SELECT id, name, command, status, required, exit_code AS "exitCode",
                  started_at AS "startedAt", completed_at AS "completedAt"
           FROM verification_runs WHERE task_id = $1 ORDER BY created_at`,
          [task.id],
        ),
        this.database.query<Record<string, unknown>>(
          `SELECT id, severity, file_path AS "filePath", line_number AS "lineNumber",
                  title, rationale, status, created_at AS "createdAt"
           FROM review_findings WHERE task_id = $1 ORDER BY created_at`,
          [task.id],
        ),
        this.database.query<Record<string, unknown>>(
          `SELECT id, reviewed_sha AS "reviewedSha", status, summary,
                  created_at AS "createdAt", completed_at AS "completedAt"
           FROM review_runs WHERE task_id = $1 ORDER BY created_at`,
          [task.id],
        ),
        this.database.query<Record<string, unknown>>(
          `SELECT number, url, head_sha AS "headSha", state,
                  created_at AS "createdAt", updated_at AS "updatedAt"
           FROM pull_requests WHERE task_id = $1`,
          [task.id],
        ),
        this.database.query<Record<string, unknown>>(
          `SELECT base_sha AS "baseSha", head_sha AS "headSha",
                  branch_name AS "branchName", status, updated_at AS "updatedAt"
           FROM git_refs WHERE task_id = $1 ORDER BY updated_at DESC LIMIT 1`,
          [task.id],
        ),
      ]);
    return {
      taskId: task.id,
      attempts: attempts.rows,
      costs: costs.rows,
      verification: verification.rows,
      findings: findings.rows,
      review: review.rows,
      pullRequest: pull.rows[0] ?? null,
      git: git.rows[0] ?? null,
    };
  }

  async requestPipelineAction(
    reference: string,
    action: 'check' | 'review' | 'fix' | 'publish',
    actor: ApiActor,
    reason: string,
  ): Promise<{
    taskId: string;
    action: string;
    queued: boolean;
    replayed: boolean;
  }> {
    const task = await this.getTask(reference, actor);
    if (!reason.trim()) throw new ConflictError('A reason is required');
    const evidence = await this.taskEvidence(task.id, actor);
    if (
      action === 'review' &&
      (evidence.verification.length === 0 ||
        evidence.verification.some(
          (item) => item.required === true && item.status !== 'PASSED',
        ))
    ) {
      throw new ConflictError('Review requires passed verification');
    }
    if (
      action === 'publish' &&
      !evidence.review.some((item) => item.status === 'PASSED')
    ) {
      throw new ConflictError('Publishing requires a passed review');
    }
    const gitRef = evidence.git;
    const headSha = typeof gitRef?.headSha === 'string' ? gitRef.headSha : null;
    const baseSha = typeof gitRef?.baseSha === 'string' ? gitRef.baseSha : null;
    const snapshot = headSha ?? baseSha ?? 'unbound';
    const queued = await this.outbox.enqueue({
      topic: `task.${action}`,
      aggregateType: 'task',
      aggregateId: task.id,
      idempotencyKey: `${action}:${task.id}:${snapshot}`,
      payload: {
        taskId: task.id,
        requestedBy: actor.actorId,
        reason: reason.slice(0, 1_000),
        snapshot,
      },
    });
    return {
      taskId: task.id,
      action,
      queued: true,
      replayed: queued.replayed,
    };
  }

  async workspaceContext(
    taskId: string,
    actor: ApiActor,
  ): Promise<Record<string, unknown>> {
    const task = await this.getTask(taskId, actor);
    const result = await this.database.query<{
      state: string;
      owner_actor_id: string | null;
      fencing_token: string;
      lease_expires_at: Date;
      worktree_path: string | null;
      base_sha: string | null;
      head_sha: string | null;
      branch_name: string | null;
      full_name: string;
    }>(
      `SELECT ownership.state, ownership.owner_actor_id,
              ownership.fencing_token::text, ownership.lease_expires_at,
              ref.worktree_path, ref.base_sha, ref.head_sha, ref.branch_name,
              repository.full_name
       FROM workspace_ownerships AS ownership
       JOIN repositories AS repository ON repository.id = ownership.repository_id
       LEFT JOIN git_refs AS ref ON ref.id = ownership.git_ref_id
       WHERE ownership.task_id = $1`,
      [task.id],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Task workspace was not found');
    if (
      row.state !== 'HUMAN_OWNED' ||
      row.owner_actor_id !== actor.actorId ||
      row.lease_expires_at <= new Date()
    ) {
      throw new ConflictError('Workspace is not actively owned by this actor');
    }
    if (!row.worktree_path) {
      throw new ConflictError('Human-owned workspace has no managed worktree');
    }
    return {
      taskId: task.id,
      taskKey: task.taskKey,
      repository: row.full_name,
      branch: row.branch_name,
      baseSha: row.base_sha,
      headSha: row.head_sha,
      path: row.worktree_path,
      fencingToken: row.fencing_token,
      leaseExpiresAt: iso(row.lease_expires_at),
    };
  }

  async linkChannel(
    input: {
      channel: 'EMAIL' | 'TELEGRAM';
      destination: string;
      projectId?: string | undefined;
    },
    actor: ApiActor,
  ): Promise<{ identity: ChannelIdentity; verificationQueued: true }> {
    if (input.projectId) assertProjectScope(actor, input.projectId);
    const destination = input.destination.trim().toLowerCase();
    if (
      (input.channel === 'EMAIL' &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) ||
      (input.channel === 'TELEGRAM' && !/^-?\d{3,20}$/.test(destination))
    ) {
      throw new RangeError('Channel destination is invalid');
    }
    const verificationCode = randomBytes(18).toString('base64url');
    const digest = createHash('sha256').update(destination).digest('hex');
    const verificationDigest = createHash('sha256')
      .update(verificationCode)
      .digest('hex');
    const id = randomUUID();
    const result = await this.database.query<ChannelRow>(
      `INSERT INTO channel_identities
        (id, identity_id, project_id, channel, role,
         external_identity_digest, destination, destination_hint,
         verification_digest, verification_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '15 minutes')
       ON CONFLICT (channel, external_identity_digest) DO UPDATE SET
         identity_id = EXCLUDED.identity_id, project_id = EXCLUDED.project_id,
         role = EXCLUDED.role, destination = EXCLUDED.destination,
         destination_hint = EXCLUDED.destination_hint, status = 'PENDING',
         verification_digest = EXCLUDED.verification_digest,
         verification_expires_at = EXCLUDED.verification_expires_at,
         verified_at = NULL, revoked_at = NULL, updated_at = now()
       RETURNING id, channel, project_id, role, destination_hint, status,
         verified_at, created_at, updated_at`,
      [
        id,
        actor.identityId,
        input.projectId ?? null,
        input.channel,
        actor.role,
        digest,
        destination,
        destinationHint(input.channel, destination),
        verificationDigest,
      ],
    );
    const identity = mapChannel(
      requireRow(result.rows[0], 'Channel link returned no record'),
    );
    await this.outbox.enqueue({
      topic: ['channel', input.channel.toLowerCase()].join('.'),
      aggregateType: 'channel_identity',
      aggregateId: identity.id,
      idempotencyKey: [
        'verify',
        identity.id,
        verificationDigest.slice(0, 16),
      ].join(':'),
      payload: {
        kind: 'IDENTITY_VERIFICATION',
        channel: input.channel,
        destination,
        verificationCode,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      },
    });
    return {
      identity,
      verificationQueued: true,
    };
  }

  async listChannels(actor: ApiActor): Promise<ChannelIdentity[]> {
    const result = await this.database.query<ChannelRow>(
      `SELECT id, channel, project_id, role, destination_hint, status,
              verified_at, created_at, updated_at
       FROM channel_identities WHERE identity_id = $1 ORDER BY channel, created_at`,
      [actor.identityId],
    );
    return result.rows.map(mapChannel);
  }

  async verifyChannel(
    identityId: string,
    code: string,
    actor: ApiActor,
  ): Promise<ChannelIdentity> {
    const digest = createHash('sha256').update(code).digest('hex');
    const result = await this.database.query<ChannelRow>(
      `UPDATE channel_identities SET status = 'VERIFIED', verified_at = now(),
         verification_digest = NULL, verification_expires_at = NULL,
         updated_at = now()
       WHERE id = $1 AND identity_id = $2 AND status = 'PENDING'
         AND verification_digest = $3 AND verification_expires_at > now()
       RETURNING id, channel, project_id, role, destination_hint, status,
         verified_at, created_at, updated_at`,
      [identityId, actor.identityId, digest],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConflictError(
        'Verification code is invalid, stale, or replayed',
      );
    }
    return mapChannel(row);
  }

  async setChannelStatus(
    identityId: string,
    status: 'VERIFIED' | 'DISABLED' | 'REVOKED',
    actor: ApiActor,
  ): Promise<ChannelIdentity> {
    const result = await this.database.query<ChannelRow>(
      `UPDATE channel_identities SET status = $3,
         revoked_at = CASE WHEN $3 = 'REVOKED' THEN now() ELSE revoked_at END,
         updated_at = now()
       WHERE id = $1 AND identity_id = $2 AND status <> 'REVOKED'
       RETURNING id, channel, project_id, role, destination_hint, status,
         verified_at, created_at, updated_at`,
      [identityId, actor.identityId, status],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Active channel identity was not found');
    return mapChannel(row);
  }

  async setChannelPreference(
    preference: ChannelPreference,
    actor: ApiActor,
  ): Promise<ChannelPreference> {
    if (preference.projectId) assertProjectScope(actor, preference.projectId);
    const result = await this.database.query<{
      channel: ChannelPreference['channel'];
      project_id: string | null;
      minimum_severity: ChannelPreference['minimumSeverity'];
      delivery_mode: ChannelPreference['deliveryMode'];
      quiet_hours_start: string | null;
      quiet_hours_end: string | null;
      timezone: string;
      escalation_minutes: number | null;
    }>(
      `INSERT INTO channel_preferences
        (id, identity_id, project_id, channel, minimum_severity, delivery_mode,
         quiet_hours_start, quiet_hours_end, timezone, escalation_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (
         identity_id, channel,
         (COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
       ) DO UPDATE SET minimum_severity = EXCLUDED.minimum_severity,
         delivery_mode = EXCLUDED.delivery_mode,
         quiet_hours_start = EXCLUDED.quiet_hours_start,
         quiet_hours_end = EXCLUDED.quiet_hours_end,
         timezone = EXCLUDED.timezone,
         escalation_minutes = EXCLUDED.escalation_minutes,
         updated_at = now()
       RETURNING channel, project_id, minimum_severity, delivery_mode,
         quiet_hours_start::text, quiet_hours_end::text, timezone,
         escalation_minutes`,
      [
        randomUUID(),
        actor.identityId,
        preference.projectId,
        preference.channel,
        preference.minimumSeverity,
        preference.deliveryMode,
        preference.quietHoursStart,
        preference.quietHoursEnd,
        preference.timezone,
        preference.escalationMinutes,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Channel preference returned no record');
    return {
      channel: row.channel,
      projectId: row.project_id,
      minimumSeverity: row.minimum_severity,
      deliveryMode: row.delivery_mode,
      quietHoursStart: row.quiet_hours_start?.slice(0, 5) ?? null,
      quietHoursEnd: row.quiet_hours_end?.slice(0, 5) ?? null,
      timezone: row.timezone,
      escalationMinutes: row.escalation_minutes,
    };
  }

  async configureConnector(
    channel: 'EMAIL' | 'TELEGRAM',
    input: {
      enabled: boolean;
      credentialReference?: string | undefined;
      configuration?: Record<string, unknown> | undefined;
    },
    actor: ApiActor,
  ): Promise<Record<string, unknown>> {
    requireOwner(actor);
    if (input.enabled && !input.credentialReference?.startsWith('secret://')) {
      throw new ConflictError(
        'Enabled connectors require a secret:// credential reference',
      );
    }
    const result = await this.database.query<ConnectorRow>(
      `UPDATE connector_states SET enabled = $2,
         credential_reference = COALESCE($3, credential_reference),
         configuration = COALESCE($4, configuration), updated_at = now()
       WHERE channel = $1
       RETURNING channel, enabled,
         CASE WHEN credential_reference IS NULL THEN NULL
              ELSE 'configured' END AS "credentialStatus",
         configuration, failure_count AS "failureCount",
         circuit_open_until AS "circuitOpenUntil",
         last_success_at AS "lastSuccessAt",
         last_failure_at AS "lastFailureAt", updated_at AS "updatedAt"`,
      [
        channel,
        input.enabled,
        input.credentialReference ?? null,
        input.configuration ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Connector was not found');
    return mapConnector(row);
  }

  async listConnectors(actor: ApiActor): Promise<Record<string, unknown>[]> {
    requireOwner(actor);
    const result = await this.database.query<ConnectorRow>(
      `SELECT channel, enabled,
              CASE WHEN credential_reference IS NULL THEN NULL
                   ELSE 'configured' END AS "credentialStatus",
              configuration, failure_count AS "failureCount",
              circuit_open_until AS "circuitOpenUntil",
              last_success_at AS "lastSuccessAt",
              last_failure_at AS "lastFailureAt", updated_at AS "updatedAt"
       FROM connector_states ORDER BY channel`,
    );
    return result.rows.map(mapConnector);
  }

  async getConnector(
    channel: 'EMAIL' | 'TELEGRAM',
    actor: ApiActor,
  ): Promise<Record<string, unknown>> {
    requireOwner(actor);
    const result = await this.database.query<ConnectorRow>(
      `SELECT channel, enabled,
              CASE WHEN credential_reference IS NULL THEN NULL
                   ELSE 'configured' END AS "credentialStatus",
              configuration, failure_count AS "failureCount",
              circuit_open_until AS "circuitOpenUntil",
              last_success_at AS "lastSuccessAt",
              last_failure_at AS "lastFailureAt", updated_at AS "updatedAt"
       FROM connector_states WHERE channel = $1`,
      [channel],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Connector was not found');
    return mapConnector(row);
  }

  async testConnector(
    channel: 'EMAIL' | 'TELEGRAM',
    actor: ApiActor,
  ): Promise<Record<string, unknown>> {
    requireOwner(actor);
    const connector = await this.getConnector(channel, actor);
    if (connector.enabled !== true) {
      throw new ConflictError('Connector must be enabled before testing');
    }
    const identity = await this.database.query<{
      id: string;
      project_id: string | null;
      destination: string;
      destination_hint: string;
    }>(
      `SELECT id, project_id, destination, destination_hint
       FROM channel_identities
       WHERE identity_id = $1 AND channel = $2 AND status = 'VERIFIED'
       ORDER BY project_id NULLS FIRST, verified_at DESC
       LIMIT 1`,
      [actor.identityId, channel],
    );
    const row = identity.rows[0];
    if (!row) {
      throw new ConflictError(
        'A verified channel identity is required before testing the connector',
      );
    }
    const eventId = randomUUID();
    const queued = await this.outbox.enqueue({
      topic: ['channel', channel.toLowerCase()].join('.'),
      aggregateType: 'runtime',
      aggregateId: eventId,
      idempotencyKey: ['connector-test', channel, actor.identityId].join(':'),
      payload: {
        kind: 'NOTIFICATION',
        channel,
        channelIdentityId: row.id,
        destination: row.destination,
        event: {
          version: 1,
          eventId,
          taskId: null,
          projectId: row.project_id,
          type: 'CONNECTOR_TEST',
          severity: 'INFO',
          title: `${channel} connector test`,
          summary:
            'This is a Praxrail connector test. If you received it, outbound delivery is configured.',
          action: null,
          expiresAt: null,
        },
        subject: '[Praxrail] Connector test',
        text: 'Praxrail connector test delivered successfully.',
        html: '<strong>Praxrail connector test</strong><p>Delivered successfully.</p>',
      },
    });
    return {
      channel,
      queued: true,
      replayed: queued.replayed,
      identityId: row.id,
      destinationHint: row.destination_hint,
    };
  }

  async doctor(): Promise<DiagnosticReport> {
    const [databaseReady, migrations, queues, workers, connectors] =
      await Promise.all([
        this.database.isReady(),
        this.database.query<{ name: string }>(
          'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
        ),
        this.database.query<{ pending: string }>(
          `SELECT count(*)::text AS pending FROM outbox_events
           WHERE status IN ('PENDING', 'FAILED')`,
        ),
        this.database.query<{ active: string }>(
          `SELECT count(*)::text AS active FROM workers
           WHERE status = 'ACTIVE' AND lease_expires_at > now()`,
        ),
        this.database.query<{ enabled: boolean; channel: string }>(
          'SELECT channel, enabled FROM connector_states ORDER BY channel',
        ),
      ]);
    const checks: DiagnosticReport['checks'] = [
      {
        name: 'database',
        status: databaseReady ? 'PASS' : 'FAIL',
        message: databaseReady
          ? 'PostgreSQL is reachable'
          : 'PostgreSQL is unavailable',
        remediation: databaseReady
          ? null
          : 'Start PostgreSQL and verify DATABASE_URL and role permissions',
      },
      {
        name: 'schema',
        status:
          migrations.rows[0]?.name === '007_product_workflows.sql'
            ? 'PASS'
            : 'FAIL',
        message: `Latest migration: ${migrations.rows[0]?.name ?? 'none'}`,
        remediation:
          migrations.rows[0]?.name === '007_product_workflows.sql'
            ? null
            : 'Run praxrail upgrade preflight and pnpm db:migrate',
      },
      {
        name: 'workers',
        status: workers.rows[0]?.active === '0' ? 'WARN' : 'PASS',
        message: `${workers.rows[0]?.active ?? '0'} active workers`,
        remediation:
          workers.rows[0]?.active === '0'
            ? 'Start or register a compatible worker before assigning tasks'
            : null,
      },
      {
        name: 'outbox',
        status: Number(queues.rows[0]?.pending ?? 0) > 1_000 ? 'WARN' : 'PASS',
        message: `${queues.rows[0]?.pending ?? '0'} pending deliveries`,
        remediation:
          Number(queues.rows[0]?.pending ?? 0) > 1_000
            ? 'Inspect connector circuits and retry dead letters'
            : null,
      },
      ...connectors.rows.map((connector) => ({
        name: `connector.${connector.channel.toLowerCase()}`,
        status: connector.enabled ? ('PASS' as const) : ('WARN' as const),
        message: connector.enabled ? 'Enabled' : 'Disabled',
        remediation: connector.enabled
          ? null
          : `Configure and test ${connector.channel.toLowerCase()} if required`,
      })),
    ];
    return {
      status: checks.some((check) => check.status === 'FAIL')
        ? 'BLOCKED'
        : checks.some((check) => check.status === 'WARN')
          ? 'DEGRADED'
          : 'READY',
      generatedAt: new Date().toISOString(),
      apiVersion: 'v1',
      runtimeVersion: '0.3.0',
      databaseVersion: migrations.rows[0]?.name ?? 'none',
      minimumClientVersion: '0.3.0',
      checks,
    };
  }

  async upgradePreflight(): Promise<{
    compatible: boolean;
    blockers: string[];
    steps: string[];
  }> {
    const [humanOwned, publishing, migration] = await Promise.all([
      this.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM workspace_ownerships
         WHERE state IN ('HUMAN_OWNED', 'PAUSING', 'RETURNING')`,
      ),
      this.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tasks
         WHERE status IN ('CI', 'PR_READY', 'AWAITING_APPROVAL')`,
      ),
      this.database.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
      ),
    ]);
    const blockers = [
      ...(humanOwned.rows[0]?.count === '0'
        ? []
        : ['Human-owned or transitioning workspaces must be returned first']),
      ...(publishing.rows[0]?.count === '0'
        ? []
        : ['Publishing tasks must settle before runtime drain']),
      ...(migration.rows[0]?.name === '007_product_workflows.sql'
        ? []
        : ['Database schema is not at the expected product version']),
    ];
    return {
      compatible: blockers.length === 0,
      blockers,
      steps: [
        'Drain workers',
        'Create and verify a database backup',
        'Install packages with recorded checksums',
        'Run forward-only migrations',
        'Restart runtime and reconcile leases',
        'Run doctor and resume workers',
      ],
    };
  }

  async supportBundle(): Promise<SupportBundle> {
    const [tasks, workers, deliveries, failures] = await Promise.all([
      this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tasks',
      ),
      this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM workers',
      ),
      this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM notification_deliveries',
      ),
      this.database.query<Record<string, unknown>>(
        `SELECT event_type AS "eventType", actor_type AS "actorType",
                occurred_at AS "occurredAt"
         FROM task_events
         WHERE event_type LIKE '%FAILED%' OR event_type LIKE '%BLOCKED%'
         ORDER BY id DESC LIMIT 50`,
      ),
    ]);
    const doctor = await this.doctor();
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      manifest: [
        'runtime.json',
        'resource-counts.json',
        'recent-failure-metadata.json',
      ],
      runtime: {
        status: doctor.status,
        apiVersion: doctor.apiVersion,
        runtimeVersion: doctor.runtimeVersion,
        databaseVersion: doctor.databaseVersion,
        checks: doctor.checks,
      },
      counts: {
        tasks: Number(tasks.rows[0]?.count ?? 0),
        workers: Number(workers.rows[0]?.count ?? 0),
        deliveries: Number(deliveries.rows[0]?.count ?? 0),
      },
      recentFailures: failures.rows,
    };
  }
}
