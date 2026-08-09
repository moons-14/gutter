import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = process.cwd();
const project = `gutter-auth-${randomBytes(6).toString('hex')}`;

test(
  'M5 auth uses a disposable Compose-internal test runner',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gutter-auth-'));
    const secret = join(directory, 'better_auth_secret');
    const override = join(directory, 'compose.yaml');
    const compose = ['compose', '--project-name', project, '-f', 'compose.yaml', '-f', override];
    try {
      await writeFile(secret, randomBytes(48).toString('base64url'), { mode: 0o444 });
      await writeFile(
        override,
        `services:\n  web:\n    ports: !override []\nsecrets:\n  better_auth_secret:\n    file: ${secret}\n`,
      );
      const effective = JSON.parse(
        (
          await exec('docker', [...compose, 'config', '--format', 'json'], {
            cwd: root,
            timeout: 30_000,
          })
        ).stdout,
      ) as {
        services: Record<string, { ports?: unknown[] }>;
      };
      assert.deepEqual(effective.services.web?.ports ?? [], []);
      assert.deepEqual(effective.services.db?.ports ?? [], []);
      await exec('docker', [...compose, 'up', '--wait'], { cwd: root, timeout: 180_000 });
      await exec(
        'docker',
        [...compose, '--profile', 'auth-test', 'build', '--quiet', 'auth-test'],
        { cwd: root, timeout: 300_000 },
      );
      try {
        await exec(
          'docker',
          [
            ...compose,
            '--profile',
            'auth-test',
            'up',
            '--no-deps',
            '--abort-on-container-failure',
            'auth-rate-peer-a',
            'auth-rate-peer-b',
          ],
          { cwd: root, timeout: 90_000 },
        );
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        const diagnostic = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.slice(-8_000);
        throw new Error(
          `auth peer rate-limit isolation failed:\n${diagnostic || 'no peer diagnostics'}`,
          {
            cause: error,
          },
        );
      }
      try {
        await exec(
          'docker',
          [...compose, '--profile', 'auth-test', 'run', '--rm', '--no-deps', 'auth-test'],
          { cwd: root, timeout: 300_000 },
        );
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        const diagnostic = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.slice(-8_000);
        throw new Error(`auth runtime failed:\n${diagnostic || 'no runner diagnostics'}`, {
          cause: error,
        });
      }
    } finally {
      await exec(
        'docker',
        [...compose, '--profile', 'auth-test', 'down', '-v', '--remove-orphans'],
        { cwd: root, timeout: 90_000 },
      ).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  { timeout: 420_000 },
);
