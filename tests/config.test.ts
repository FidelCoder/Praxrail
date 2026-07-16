import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:password@localhost:5433/database',
};

describe('loadConfig', () => {
  it('loads safe defaults and resolves managed roots', () => {
    const config = loadConfig(base, '/work');
    expect(config.environment).toBe('test');
    expect(config.paths.workspaceRoot).toBe('/work/.praxrail/workspaces');
    expect(config.telegram.enabled).toBe(false);
    expect(config.github.enabled).toBe(false);
    expect(config.codex.enabled).toBe(false);
    expect(config.jobs).toEqual({
      concurrency: 4,
      retryLimit: 3,
      retryDelaySeconds: 5,
    });
  });

  it('does not coerce the string false to true', () => {
    const config = loadConfig({ ...base, TELEGRAM_ENABLED: 'false' });
    expect(config.telegram.enabled).toBe(false);
  });

  it('fails closed when Telegram is enabled without credentials', () => {
    expect(() => loadConfig({ ...base, TELEGRAM_ENABLED: 'true' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it('loads an enabled GitHub App and normalizes repository names', () => {
    const privateKey = Buffer.from('unit-test PRIVATE KEY material').toString(
      'base64',
    );
    const config = loadConfig({
      ...base,
      GITHUB_ENABLED: 'true',
      GITHUB_APP_ID: '1234',
      GITHUB_PRIVATE_KEY_BASE64: privateKey,
      GITHUB_WEBHOOK_SECRET: 'a-secure-webhook-secret',
      GITHUB_ALLOWED_REPOSITORIES: 'FidelCoder/Praxrail,Example/Other',
    });
    expect(config.github.privateKey).toContain('PRIVATE KEY');
    expect(config.github.allowedRepositories.has('fidelcoder/praxrail')).toBe(
      true,
    );
    expect(JSON.stringify(config)).toBe('"[REDACTED]"');
    expect(JSON.stringify(config.github)).toBe('"[REDACTED]"');
    expect(JSON.stringify(config.database)).toBe('"[REDACTED]"');
  });

  it('fails closed for incomplete Codex configuration and redacts its key', () => {
    expect(() => loadConfig({ ...base, CODEX_ENABLED: 'true' })).toThrow(
      /CODEX_BUILDER_API_KEY/,
    );
    const config = loadConfig({
      ...base,
      CODEX_ENABLED: 'true',
      CODEX_BUILDER_API_KEY: 'codex-builder-key-with-safe-length',
      CODEX_REVIEWER_API_KEY: 'codex-reviewer-key-with-safe-length',
      CODEX_MODEL: 'gpt-test',
    });
    expect(config.codex.enabled).toBe(true);
    expect(config.codex.model).toBe('gpt-test');
    expect(JSON.stringify(config.codex)).toBe('"[REDACTED]"');
    expect(JSON.stringify(config)).not.toContain('codex-builder-key');
    expect(() =>
      loadConfig({
        ...base,
        CODEX_ENABLED: 'true',
        CODEX_BUILDER_API_KEY: 'same-codex-key-with-safe-length',
        CODEX_REVIEWER_API_KEY: 'same-codex-key-with-safe-length',
        CODEX_MODEL: 'gpt-test',
      }),
    ).toThrow(/must be distinct/);
  });

  it('loads secrets from mounted files without overriding explicit values', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'praxrail-secrets-'));
    const databaseFile = path.join(directory, 'database-url');
    writeFileSync(
      databaseFile,
      'postgres://file-user:file-password@localhost:5433/database\n',
    );
    try {
      expect(
        loadConfig({ NODE_ENV: 'test', DATABASE_URL_FILE: databaseFile })
          .database.url,
      ).toContain('file-user');
      expect(
        loadConfig({
          ...base,
          DATABASE_URL_FILE: databaseFile,
        }).database.url,
      ).toBe(base.DATABASE_URL);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unsafe budget relationships and root paths', () => {
    expect(() =>
      loadConfig({ ...base, TASK_BUDGET_USD: '30', DAILY_BUDGET_USD: '25' }),
    ).toThrow(/Task budget/);
    expect(() => loadConfig({ ...base, WORKSPACE_ROOT: '/' })).toThrow(
      /filesystem root/,
    );
    expect(() => loadConfig({ ...base, JOB_CONCURRENCY: '0' })).toThrow();
  });
});
