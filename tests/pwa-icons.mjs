import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const generator = join(root, 'scripts', 'generate-pwa-icons.mjs');
const committedIcons = join(root, 'apps', 'web', 'static', 'icons');
const expectedFiles = ['icon-192.png', 'icon-512.png'];

async function generate(directory) {
  await execFileAsync(process.execPath, [generator, directory], { cwd: root });
  assert.deepEqual((await readdir(directory)).sort(), expectedFiles);
}

test('PWA icon artifacts are deterministic, sized correctly, and match the manifest', async () => {
  const first = await mkdtemp(join(tmpdir(), 'gutter-pwa-icons-first-'));
  const second = await mkdtemp(join(tmpdir(), 'gutter-pwa-icons-second-'));
  try {
    await generate(first);
    await generate(second);
    for (const [file, size] of [
      ['icon-192.png', 192],
      ['icon-512.png', 512],
    ]) {
      const generated = await readFile(join(first, file));
      assert.deepEqual(generated, await readFile(join(second, file)));
      assert.deepEqual(generated, await readFile(join(committedIcons, file)));
      const metadata = await sharp(generated).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size);
    }

    const manifest = JSON.parse(
      await readFile(join(root, 'apps', 'web', 'static', 'manifest.webmanifest'), 'utf8'),
    );
    assert.deepEqual(manifest.icons, [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ]);
    const layout = await readFile(
      join(root, 'apps', 'web', 'src', 'routes', '+layout.svelte'),
      'utf8',
    );
    assert.match(layout, /<link rel="manifest" href="\/manifest\.webmanifest"\s*\/>/);
  } finally {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
});
