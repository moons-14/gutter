import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const source = fileURLToPath(new URL('./pwa-icon.svg', import.meta.url));
const defaultOutput = fileURLToPath(new URL('../apps/web/static/icons/', import.meta.url));
const output = path.resolve(process.argv[2] ?? defaultOutput);
await mkdir(output, { recursive: true });
for (const size of [192, 512]) {
  await sharp(source)
    .resize(size, size)
    .png()
    .toFile(path.join(output, `icon-${size}.png`));
}
