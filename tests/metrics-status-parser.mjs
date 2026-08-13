import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';

const parser =
  '/^[[:space:]]*HTTP\\/[0-9.]+[[:space:]][0-9][0-9][0-9]([[:space:]]|$)/ { if ($2 ~ /^[0-9][0-9][0-9]$/) { print $2; exit } }';

async function parseStatus(output) {
  return new Promise((resolve, reject) => {
    const child = execFile('awk', [parser], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
    child.stdin.end(output);
  });
}

test('extracts the numeric status from BusyBox wget diagnostics', async () => {
  assert.equal(
    await parseStatus(
      '  HTTP/1.1 404 Not Found\nwget: server returned error: HTTP/1.1 404 Not Found\n',
    ),
    '404',
  );
});

test('rejects malformed or non-status HTTP-looking diagnostics', async () => {
  assert.equal(
    await parseStatus('wget: server returned error: HTTP/1.1 nope\nHTTP/1.1 server\n'),
    '',
  );
});
