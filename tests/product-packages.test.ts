import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertWorkspaceOwnershipTransition,
  workerRegistrationSchema,
} from '@praxrail/core';
import { describe, expect, it, vi } from 'vitest';
import {
  PraxrailClient,
  PraxrailClientError,
  NodeHttpTransport,
  ProfileStore,
  type ClientTransport,
} from '../packages/client/src/index.js';
import {
  readRuntimeLog,
  runtimePaths,
  runtimePid,
  startRuntimeProcess,
  stopRuntimeProcess,
} from '../packages/cli/src/lifecycle.js';
import { runCli } from '../packages/cli/src/index.js';
import { acquireProcessLock } from '../src/runtime/process-lock.js';

const token = `pxr_${'a'.repeat(40)}`;

describe('product packages', () => {
  it('validates custom worker capabilities and ownership transitions', () => {
    expect(
      workerRegistrationSchema.parse({
        name: 'local-worker',
        mode: 'EMBEDDED',
        version: '0.2.0',
        profiles: ['mobile', 'data-engineering'],
        repositoryIds: ['22222222-2222-4222-8222-222222222222'],
      }).profiles,
    ).toEqual(['mobile', 'data-engineering']);
    expect(() =>
      assertWorkspaceOwnershipTransition('AGENT_OWNED', 'HUMAN_OWNED'),
    ).toThrow(/cannot transition/);
    expect(() =>
      assertWorkspaceOwnershipTransition('AGENT_OWNED', 'PAUSING'),
    ).not.toThrow();
  });

  it('uses typed transport results and stable API errors', async () => {
    const request = vi
      .fn<ClientTransport['request']>()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({
          apiVersion: 'v1',
          runtimeVersion: '0.2.0',
          status: 'READY',
          database: true,
          queue: true,
          mode: 'LOCAL',
        }),
      })
      .mockResolvedValueOnce({
        status: 403,
        headers: {},
        body: JSON.stringify({
          error: 'ACTION_NOT_PERMITTED',
          message: 'Action is not permitted',
          correlationId: 'request-1',
          retryable: false,
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          name: 'local-worker',
          mode: 'EMBEDDED',
          version: '0.2.0',
          status: 'ACTIVE',
          profiles: ['builder'],
          repositoryIds: ['22222222-2222-4222-8222-222222222222'],
          fencingToken: '7',
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    const client = new PraxrailClient({
      endpoint: 'unix:///tmp/praxrail.sock',
      token,
      transport: { request },
    });
    expect((await client.runtimeStatus()).status).toBe('READY');
    await expect(client.listTasks()).rejects.toMatchObject({
      status: 403,
      detail: { error: 'ACTION_NOT_PERMITTED' },
    });
    await client.registerWorker(
      {
        name: 'local-worker',
        mode: 'EMBEDDED',
        version: '0.2.0',
        profiles: ['builder'],
        repositoryIds: ['22222222-2222-4222-8222-222222222222'],
      },
      'registration-attempt-1',
    );
    expect(request.mock.calls[0]?.[0].headers.authorization).toBe(
      `Bearer ${token}`,
    );
    expect(request.mock.calls[2]?.[0].headers['idempotency-key']).toBe(
      'registration-attempt-1',
    );
  });

  it('retries safe reads and resumes typed output by cursor', async () => {
    const retryable = {
      error: 'UNAVAILABLE',
      message: 'Runtime is restarting',
      correlationId: 'request-retry',
      retryable: true,
    };
    const request = vi
      .fn<ClientTransport['request']>()
      .mockResolvedValueOnce({
        status: 503,
        headers: {},
        body: JSON.stringify(retryable),
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: '[]' })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({
          chunks: [
            {
              id: 9,
              taskId: '33333333-3333-4333-8333-333333333333',
              attemptId: null,
              stream: 'SYSTEM',
              content: 'ready',
              truncated: false,
              occurredAt: new Date().toISOString(),
            },
          ],
          nextCursor: 9,
        }),
      });
    const client = new PraxrailClient({
      endpoint: 'unix:///tmp/praxrail.sock',
      token,
      transport: { request },
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });
    expect(await client.listTasks()).toEqual([]);
    expect(
      (
        await client.output({
          taskId: '33333333-3333-4333-8333-333333333333',
          cursor: 8,
        })
      ).nextCursor,
    ).toBe(9);
    expect(request).toHaveBeenCalledTimes(3);

    const unsafeRequest = vi
      .fn<ClientTransport['request']>()
      .mockRejectedValue(new Error('connection lost'));
    const unsafeClient = new PraxrailClient({
      endpoint: 'unix:///tmp/praxrail.sock',
      token,
      transport: { request: unsafeRequest },
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });
    await expect(unsafeClient.rotateToken()).rejects.toThrow(/connection lost/);
    expect(unsafeRequest).toHaveBeenCalledOnce();
  });

  it('stores connection profiles in a protected fallback file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'praxrail-profile-'));
    const profile = {
      endpoint: 'unix:///tmp/praxrail.sock',
      token,
      allowInsecureRemote: false,
    };
    try {
      const store = new ProfileStore(directory);
      await expect(store.get()).rejects.toThrow(/No Praxrail/);
      await expect(store.save('bad profile', profile)).rejects.toThrow(
        /name is invalid/,
      );
      await store.save('local', profile);
      expect((await store.get()).endpoint).toContain('unix://');
      await expect(store.use('missing')).rejects.toThrow(/was not found/);
      await store.save('backup', profile, false);
      await store.remove('backup');
      expect((await store.list()).current).toBe('local');
      const filename = path.join(directory, 'profiles.json');
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      expect(await readFile(filename, 'utf8')).toContain('"current": "local"');
      await store.remove('local');
      await expect(readFile(filename, 'utf8')).rejects.toThrow();
      await expect(store.get()).rejects.toThrow(/No Praxrail/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('provides deterministic CLI output and exit codes', async () => {
    let stdout = '';
    let stderr = '';
    const io = {
      stdout: { write: (value: string) => (stdout += value) },
      stderr: { write: (value: string) => (stderr += value) },
    };
    expect(await runCli(['--json', 'version'], io)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ version: '0.3.0' });
    stdout = '';
    expect(await runCli(['unknown'], io)).toBe(2);
    expect(stderr).toContain('Unknown command');
    stdout = '';
    stderr = '';
    expect(await runCli(['--json', '--version'], io)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ version: '0.3.0' });

    stdout = '';
    stderr = '';
    const denied = new PraxrailClientError(403, {
      error: 'ACTION_NOT_PERMITTED',
      message: 'Operator role is required',
      correlationId: 'request-cli',
      retryable: false,
    });
    const paths = {
      directory: '/tmp/praxrail-cli',
      pidFile: '/tmp/praxrail-cli/runtime.pid',
      logFile: '/tmp/praxrail-cli/runtime.log',
      socketFile: '/tmp/praxrail-cli/runtime.sock',
    };
    expect(
      await runCli(['--json', 'runtime', 'status'], io, {
        runtimePaths: () => paths,
        runtimePid: async () => 42,
        createProfileStore: () => ({
          get: async () => ({
            endpoint: `unix://${paths.socketFile}`,
            token,
            allowInsecureRemote: false,
          }),
          list: async () => ({ current: null, profiles: {} }),
          use: async () => undefined,
        }),
        createClient: () => ({
          runtimeStatus: async () => Promise.reject(denied),
        }),
      }),
    ).toBe(6);
    expect(JSON.parse(stderr)).toMatchObject({
      error: 'ACTION_NOT_PERMITTED',
      exitCode: 6,
    });
  });

  it('dispatches stable product commands and confirms high-risk actions', async () => {
    let stdout = '';
    let stderr = '';
    const io = {
      stdout: { write: (value: string) => (stdout += value) },
      stderr: { write: (value: string) => (stderr += value) },
    };
    const profile = {
      endpoint: 'unix:///tmp/praxrail-product.sock',
      token,
      allowInsecureRemote: false,
    };
    const project = {
      id: '12345678-1234-4234-8234-123456789012',
      slug: 'sample-product',
      name: 'Sample Product',
      status: 'ACTIVE' as const,
      createdAt: '2026-07-17T10:00:00.000Z',
      updatedAt: '2026-07-17T10:00:00.000Z',
    };
    const dependencies = {
      createProfileStore: () => ({
        get: async () => profile,
        list: async () => ({
          current: 'local',
          profiles: { local: profile },
        }),
        use: async () => undefined,
      }),
      createClient: () => ({
        runtimeStatus: async () => ({
          apiVersion: 'v1' as const,
          runtimeVersion: '0.3.0',
          status: 'READY' as const,
          database: true,
          queue: true,
          mode: 'LOCAL' as const,
        }),
        listProjects: async () => [project],
      }),
    };

    expect(await runCli(['--json', 'project', 'list'], io, dependencies)).toBe(
      0,
    );
    expect(JSON.parse(stdout)).toEqual([project]);

    stdout = '';
    stderr = '';
    expect(
      await runCli(
        ['task', 'cancel', 'PXR-1', '--reason', 'No longer required'],
        io,
        dependencies,
      ),
    ).toBe(2);
    expect(stderr).toContain('requires --yes');
  });

  it('enforces endpoint trust, response bounds, and request timeouts', async () => {
    const request = {
      method: 'GET' as const,
      path: '/',
      headers: {},
      timeoutMs: 100,
    };
    await expect(
      new NodeHttpTransport('http://example.com').request(request),
    ).rejects.toThrow(/require HTTPS/);
    await expect(
      new NodeHttpTransport('ftp://127.0.0.1').request(request),
    ).rejects.toThrow(/unix, HTTP, or HTTPS/);

    const server = http.createServer((incoming, response) => {
      if (incoming.url === '/slow') return;
      if (incoming.url === '/large') {
        response.end('x'.repeat(2 * 1024 * 1024 + 1));
        return;
      }
      response.setHeader('x-fixture', 'transport');
      response.end('{"ok":true}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Fixture server has no TCP address');
    }
    const transport = new NodeHttpTransport(`http://127.0.0.1:${address.port}`);
    try {
      await expect(transport.request(request)).resolves.toMatchObject({
        status: 200,
        body: '{"ok":true}',
      });
      await expect(
        transport.request({ ...request, path: '/slow', timeoutMs: 20 }),
      ).rejects.toThrow(/timed out/);
      await expect(
        transport.request({ ...request, path: '/large' }),
      ).rejects.toThrow(/too large/);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('starts one ready managed runtime and recovers stale lifecycle files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'praxrail-lifecycle-'));
    const paths = runtimePaths(path.join(directory, 'state'));
    const entry = path.join(directory, 'runtime.cjs');
    await writeFile(
      entry,
      `const fs = require('node:fs');
const http = require('node:http');
fs.mkdirSync(require('node:path').dirname(process.env.PRAXRAIL_PID_FILE), { recursive: true });
fs.writeFileSync(process.env.PRAXRAIL_PID_FILE, String(process.pid));
try { fs.rmSync(process.env.API_SOCKET_PATH, { force: true }); } catch {}
const server = http.createServer((request, response) => {
  response.statusCode = request.url === '/health/ready' ? 200 : 404;
  response.end(request.url === '/health/ready' ? 'ready' : 'missing');
});
server.listen(process.env.API_SOCKET_PATH);
const shutdown = () => server.close(() => {
  fs.rmSync(process.env.PRAXRAIL_PID_FILE, { force: true });
  fs.rmSync(process.env.API_SOCKET_PATH, { force: true });
  process.exit(0);
});
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
`,
      { mode: 0o600 },
    );
    try {
      const pid = await startRuntimeProcess({ paths, entry, timeoutMs: 5_000 });
      expect(await runtimePid(paths)).toBe(pid);
      await expect(
        startRuntimeProcess({ paths, entry, timeoutMs: 100 }),
      ).rejects.toThrow(/already running/);
      const response = await new NodeHttpTransport(
        `unix://${paths.socketFile}`,
      ).request({
        method: 'GET',
        path: '/health/ready',
        headers: {},
        timeoutMs: 1_000,
      });
      expect(response.status).toBe(200);

      await writeFile(paths.logFile, 'x'.repeat(512), { mode: 0o600 });
      expect(await readRuntimeLog(paths, 64)).toHaveLength(64);
      expect(await stopRuntimeProcess(paths, 5_000)).toBe(true);
      expect(await runtimePid(paths)).toBeNull();

      await writeFile(paths.pidFile, '999999\n', { mode: 0o600 });
      expect(await runtimePid(paths)).toBeNull();
      expect(await stopRuntimeProcess(paths)).toBe(false);
      await rm(paths.logFile, { force: true });
      expect(await readRuntimeLog(paths)).toBe('');
    } finally {
      const active = await runtimePid(paths);
      if (active) await stopRuntimeProcess(paths, 5_000);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('prevents two runtime processes from owning one pid file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'praxrail-lock-'));
    const filename = path.join(directory, 'runtime.pid');
    try {
      const first = await acquireProcessLock(filename);
      await expect(acquireProcessLock(filename)).rejects.toThrow(
        /already running/,
      );
      await first.release();
      const replacement = await acquireProcessLock(filename);
      await replacement.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
