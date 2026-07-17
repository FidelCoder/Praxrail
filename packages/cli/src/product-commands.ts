import type { PraxrailClient } from 'praxrail-client';
import type { TaskStatus } from 'praxrail-core';

export interface ProductCommandOptions {
  project?: string;
  repository?: string;
  name?: string;
  slug?: string;
  status?: string;
  title?: string;
  request?: string;
  reason?: string;
  priority?: string;
  budget?: string;
  limit?: string;
  cursor?: string;
  destination?: string;
  code?: string;
  identity?: string;
  'full-name'?: string;
  'clone-url'?: string;
  'default-branch'?: string;
  'worker-profile'?: string;
  'mirror-path'?: string;
  'credential-ref'?: string;
  'minimum-severity'?: string;
  mode?: string;
  'quiet-start'?: string;
  'quiet-end'?: string;
  timezone?: string;
  escalation?: string;
  'fencing-token'?: string;
  approval?: string;
  token?: string;
  direction?: string;
  lease?: string;
  'dry-run'?: boolean;
  'include-archived'?: boolean;
  follow?: boolean;
  enable?: boolean;
  disable?: boolean;
}

export interface ProductCommandResult {
  value: unknown;
  human: string;
  exitCode?: number;
}

export interface ProductCommandInput {
  command: string;
  action?: string | undefined;
  argument?: string | undefined;
  extra?: string[] | undefined;
  options: ProductCommandOptions;
  client: PraxrailClient;
  emit: (value: unknown, human: string) => void;
  spawnShell: (context: {
    path: string;
    taskId: string;
    taskKey: string;
    repository: string;
    branch: string;
    fencingToken: string;
  }) => Promise<number>;
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function integer(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function numberValue(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function humanCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(label + ' is required');
  return required(value, label);
}

function listHuman(values: Record<string, unknown>[], keys: string[]): string {
  if (values.length === 0) return 'No matching records';
  return values
    .map((value) => keys.map((key) => humanCell(value[key])).join('  '))
    .join('\n');
}

function taskHuman(task: Record<string, unknown>): string {
  return [
    humanCell(task.taskKey) +
      '  ' +
      humanCell(task.status) +
      '  ' +
      humanCell(task.title),
    'Required action: ' + humanCell(task.requiredAction),
  ].join('\n');
}

export async function runProductCommand(
  input: ProductCommandInput,
): Promise<ProductCommandResult | null> {
  const { command, action, argument, options, client } = input;

  if (command === 'doctor' || command === 'diagnose') {
    const report = await client.doctor();
    const human = report.checks
      .map(
        (check) =>
          `${check.status.padEnd(4)}  ${check.name}: ${check.message}${
            check.remediation ? `\n      ${check.remediation}` : ''
          }`,
      )
      .join('\n');
    return {
      value: report,
      human,
      exitCode: report.status === 'READY' ? 0 : 4,
    };
  }

  if (command === 'project') {
    if (action === 'list') {
      const projects = await client.listProjects();
      return {
        value: projects,
        human: listHuman(projects, ['slug', 'status', 'name']),
      };
    }
    if (action === 'show') {
      const project = await client.getProject(required(argument, 'project'));
      return {
        value: project,
        human: `${project.slug}  ${project.status}  ${project.name}`,
      };
    }
    if (action === 'create') {
      const project = await client.createProject({
        slug: required(options.slug ?? argument, 'slug'),
        name: required(options.name, 'name'),
        dryRun: options['dry-run'],
      });
      return {
        value: project,
        human: `${project.slug} created${project.dryRun ? ' (dry run)' : ''}`,
      };
    }
    if (action === 'update' || action === 'archive') {
      const project = await client.updateProject(
        required(argument, 'project'),
        {
          ...(options.name ? { name: options.name } : {}),
          ...(action === 'archive'
            ? { status: 'DISABLED' as const }
            : options.status
              ? {
                  status: options.status.toUpperCase() as
                    'ACTIVE' | 'PAUSED' | 'DISABLED',
                }
              : {}),
          dryRun: options['dry-run'],
        },
      );
      return {
        value: project,
        human: `${project.slug} updated to ${project.status}`,
      };
    }
  }

  if (command === 'repo' || command === 'repository') {
    if (action === 'list') {
      const repositories = await client.listRepositories(options.project);
      return {
        value: repositories,
        human: listHuman(repositories, ['fullName', 'status', 'workerProfile']),
      };
    }
    if (action === 'show') {
      const repository = await client.getRepository(
        required(argument, 'repository'),
      );
      return {
        value: repository,
        human: `${repository.fullName}  ${repository.status}`,
      };
    }
    if (action === 'add') {
      const fullName = required(options['full-name'] ?? argument, 'full-name');
      const repository = await client.addRepository({
        projectId: required(options.project, 'project'),
        fullName,
        cloneUrl: options['clone-url'] ?? `https://github.com/${fullName}.git`,
        defaultBranch: options['default-branch'] ?? 'main',
        workerProfile: options['worker-profile'] ?? 'default',
        ...(options['mirror-path']
          ? { mirrorPath: options['mirror-path'] }
          : {}),
        dryRun: options['dry-run'],
      });
      return {
        value: repository,
        human: `${repository.fullName} added in PENDING state`,
      };
    }
    if (action === 'inspect') {
      const report = await client.inspectRepository(
        required(argument, 'repository'),
      );
      return {
        value: report,
        human:
          report.safeForWrites === true
            ? 'Repository inspection passed'
            : `Repository inspection blocked\n${(
                (report.findings as string[] | undefined) ?? []
              ).join('\n')}`,
        exitCode: report.safeForWrites === true ? 0 : 4,
      };
    }
    if (['approve', 'disable', 'remove'].includes(action ?? '')) {
      const result = await client.setRepositoryStatus(
        required(argument, 'repository'),
        {
          action: action as 'approve' | 'disable' | 'remove',
          dryRun: options['dry-run'],
        },
      );
      return {
        value: result,
        human: `Repository ${action} completed`,
      };
    }
  }

  if (command === 'task') {
    if (action === 'list') {
      const tasks = await client.listTaskDetails({
        ...(options.project ? { projectId: options.project } : {}),
        ...(options.repository ? { repositoryId: options.repository } : {}),
        ...(options.status
          ? { status: options.status.toUpperCase() as TaskStatus }
          : {}),
        ...(integer(options.limit, 'limit', 1, 500)
          ? { limit: integer(options.limit, 'limit', 1, 500) }
          : {}),
        includeArchived: options['include-archived'],
      });
      return {
        value: tasks,
        human: listHuman(tasks, ['taskKey', 'status', 'priority', 'title']),
      };
    }
    if (action === 'create') {
      const task = await client.createTask({
        title: required(options.title, 'title'),
        request: required(options.request, 'request'),
        projectId: required(options.project, 'project'),
        repositoryId: required(options.repository, 'repository'),
        ...(integer(options.priority, 'priority', 0, 100) !== undefined
          ? { priority: integer(options.priority, 'priority', 0, 100) }
          : {}),
        ...(numberValue(options.budget, 'budget') !== undefined
          ? { budgetUsd: numberValue(options.budget, 'budget') }
          : {}),
        dryRun: options['dry-run'],
      });
      return { value: task, human: taskHuman(task) };
    }
    if (action === 'show' || action === 'status') {
      const task = await client.getTaskDetail(required(argument, 'task'));
      return { value: task, human: taskHuman(task) };
    }
    if (
      [
        'clarify',
        'prioritize',
        'pause',
        'resume',
        'cancel',
        'retry',
        'abandon',
        'archive',
      ].includes(action ?? '')
    ) {
      const task = await client.controlTask(required(argument, 'task'), {
        action: action as
          | 'clarify'
          | 'prioritize'
          | 'pause'
          | 'resume'
          | 'cancel'
          | 'retry'
          | 'abandon'
          | 'archive',
        ...(options.reason ? { reason: options.reason } : {}),
        ...(integer(options.priority, 'priority', 0, 100) !== undefined
          ? { priority: integer(options.priority, 'priority', 0, 100) }
          : {}),
      });
      return { value: task, human: taskHuman(task) };
    }
    if (
      [
        'attempts',
        'costs',
        'verification',
        'findings',
        'diff',
        'pull-request',
      ].includes(action ?? '')
    ) {
      const evidence = await client.taskEvidence(required(argument, 'task'));
      const key =
        action === 'diff'
          ? 'git'
          : action === 'pull-request'
            ? 'pullRequest'
            : action;
      const value = evidence[key as keyof typeof evidence];
      return {
        value,
        human: JSON.stringify(value, null, 2),
        exitCode: value === null ? 3 : 0,
      };
    }
    if (['check', 'review', 'fix', 'publish'].includes(action ?? '')) {
      const result = await client.requestPipelineAction(
        required(argument, 'task'),
        action as 'check' | 'review' | 'fix' | 'publish',
        required(options.reason, 'reason'),
      );
      return { value: result, human: `Task ${action} request queued` };
    }
    if (action === 'events' || action === 'watch') {
      const task = await client.getTaskDetail(required(argument, 'task'));
      const cursor = integer(
        options.cursor,
        'cursor',
        0,
        Number.MAX_SAFE_INTEGER,
      );
      if (action === 'watch' || options.follow) {
        for await (const event of client.watch({
          taskId: task.id,
          cursor,
        })) {
          input.emit(
            event,
            `${event.occurredAt}  ${event.eventType}  ${event.actorId}`,
          );
        }
        return { value: null, human: '' };
      }
      const events = await client.events({
        taskId: task.id,
        cursor,
        limit: integer(options.limit, 'limit', 1, 500),
      });
      return {
        value: events,
        human: events.events
          .map(
            (event) =>
              `${event.occurredAt}  ${event.eventType}  ${event.actorId}`,
          )
          .join('\n'),
      };
    }
    if (action === 'logs') {
      const task = await client.getTaskDetail(required(argument, 'task'));
      if (options.follow) {
        for await (const chunk of client.watchOutput({
          taskId: task.id,
          cursor: integer(options.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER),
        })) {
          input.emit(chunk, chunk.content);
        }
        return { value: null, human: '' };
      }
      const output = await client.output({
        taskId: task.id,
        cursor: integer(options.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER),
        limit: integer(options.limit, 'limit', 1, 500),
      });
      return {
        value: output,
        human: output.chunks.map((chunk) => chunk.content).join(''),
      };
    }
    if (action === 'ownership') {
      const task = await client.getTaskDetail(required(argument, 'task'));
      const ownership = await client.workspace(task.id);
      return {
        value: ownership,
        human: `${task.taskKey} workspace is ${ownership.state}`,
      };
    }
    if (action === 'attach') {
      const task = await client.getTaskDetail(required(argument, 'task'));
      const ownership = await client.requestWorkspaceAttach(
        task.id,
        required(options.reason, 'reason'),
        integer(options.lease, 'lease', 5_000, 86_400_000) ?? 3_600_000,
      );
      return {
        value: ownership,
        human: `${task.taskKey} handoff requested; state is ${ownership.state}`,
      };
    }
    if (action === 'shell') {
      const task = await client.getTaskDetail(required(argument, 'task'));
      const raw = await client.workspaceContext(task.id);
      const context = {
        path: stringField(raw.path, 'workspace path'),
        taskId: task.id,
        taskKey: task.taskKey,
        repository: stringField(raw.repository, 'repository'),
        branch: stringField(raw.branch, 'branch'),
        fencingToken: stringField(raw.fencingToken, 'fencing token'),
      };
      const exitCode = await input.spawnShell(context);
      return {
        value: { ...context, path: undefined, shellExitCode: exitCode },
        human:
          'Shell exited; workspace remains human-owned until task return is explicit',
        exitCode,
      };
    }
    if (action === 'return') {
      const task = await client.getTaskDetail(required(argument, 'task'));
      const returned = await client.returnWorkspace(
        task.id,
        required(options['fencing-token'], 'fencing-token'),
        required(options.reason, 'reason'),
      );
      return {
        value: returned,
        human: `${task.taskKey} workspace validated and queued for agent return`,
      };
    }
    if (action === 'recover') {
      const task = await client.getTaskDetail(required(argument, 'task'));
      const recovered = await client.recoverWorkspace(
        task.id,
        (options.direction ?? 'AGENT').toUpperCase() as 'HUMAN' | 'AGENT',
        required(options.reason, 'reason'),
        integer(options.lease, 'lease', 5_000, 86_400_000) ?? 3_600_000,
      );
      return {
        value: recovered,
        human: `${task.taskKey} workspace recovery moved to ${recovered.state}`,
      };
    }
  }

  if (command === 'channel' || command === 'notify') {
    if (action === 'list') {
      const channels = await client.listChannels();
      return {
        value: channels,
        human: listHuman(channels, ['channel', 'status', 'destinationHint']),
      };
    }
    if (action === 'status') {
      const channel = argument
        ? (argument.toUpperCase() as 'EMAIL' | 'TELEGRAM')
        : undefined;
      const status = channel
        ? await client.connectorStatus(channel)
        : {
            identities: await client.listChannels(),
            connectors: await client.listConnectors(),
          };
      return {
        value: status,
        human: JSON.stringify(status, null, 2),
      };
    }
    if (action === 'link') {
      const channel = required(argument, 'channel').toUpperCase() as
        'EMAIL' | 'TELEGRAM';
      const result = await client.linkChannel({
        channel,
        destination: required(options.destination, 'destination'),
        ...(options.project ? { projectId: options.project } : {}),
      });
      return {
        value: result,
        human: `${channel} identity linked; verify with the one-time code`,
      };
    }
    if (action === 'verify') {
      const identity = await client.verifyChannel(
        required(options.identity ?? argument, 'identity'),
        required(options.code, 'code'),
      );
      return {
        value: identity,
        human: `${identity.channel} identity verified`,
      };
    }
    if (action === 'disable' || action === 'revoke') {
      const identity = await client.setChannelStatus(
        required(options.identity ?? argument, 'identity'),
        action === 'disable' ? 'DISABLED' : 'REVOKED',
      );
      return {
        value: identity,
        human: `${identity.channel} identity ${identity.status.toLowerCase()}`,
      };
    }
    if (action === 'preference') {
      const preference = await client.setChannelPreference({
        channel: required(argument, 'channel').toUpperCase() as
          'EMAIL' | 'TELEGRAM',
        projectId: options.project ?? null,
        minimumSeverity: (options['minimum-severity'] ?? 'INFO') as
          'INFO' | 'ACTION_REQUIRED' | 'WARNING' | 'CRITICAL',
        deliveryMode: (options.mode ?? 'IMMEDIATE') as
          'IMMEDIATE' | 'DIGEST' | 'MUTED',
        quietHoursStart: options['quiet-start'] ?? null,
        quietHoursEnd: options['quiet-end'] ?? null,
        timezone: options.timezone ?? 'UTC',
        escalationMinutes:
          integer(options.escalation, 'escalation', 0, 10_080) ?? null,
      });
      return {
        value: preference,
        human: `${preference.channel} preference updated`,
      };
    }
    if (action === 'setup' || action === 'rotate') {
      const channel = required(argument, 'channel').toUpperCase() as
        'EMAIL' | 'TELEGRAM';
      const enabled = options.disable ? false : (options.enable ?? true);
      const configured = await client.configureConnector(channel, {
        enabled,
        ...(options['credential-ref']
          ? { credentialReference: options['credential-ref'] }
          : {}),
      });
      return {
        value: configured,
        human: `${channel} connector configured from managed secret reference`,
      };
    }
    if (action === 'test') {
      const channel = required(argument, 'channel').toUpperCase() as
        'EMAIL' | 'TELEGRAM';
      const result = await client.testConnector(channel);
      return {
        value: result,
        human: `${channel} connector test queued`,
      };
    }
  }

  if (command === 'approval') {
    if (action === 'approve' || action === 'reject') {
      const approvalId = required(options.approval ?? argument, 'approval');
      const result = await client.decideApproval(approvalId, {
        token: required(options.token, 'token'),
        approved: action === 'approve',
        reason: required(options.reason, 'reason'),
      });
      return {
        value: result,
        human: `Approval ${action === 'approve' ? 'approved' : 'rejected'}`,
      };
    }
  }

  if (command === 'upgrade' && action === 'preflight') {
    const preflight = await client.upgradePreflight();
    return {
      value: preflight,
      human: preflight.compatible
        ? `Upgrade preflight passed\n${preflight.steps.join('\n')}`
        : `Upgrade blocked\n${preflight.blockers.join('\n')}`,
      exitCode: preflight.compatible ? 0 : 4,
    };
  }

  if (command === 'support' && action === 'bundle') {
    const bundle = await client.supportBundle();
    return {
      value: bundle,
      human: JSON.stringify(bundle, null, 2),
    };
  }

  return null;
}
