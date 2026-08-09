import { derivedCacheConfig } from '@gutter/config';
import { DerivedCache } from '@gutter/derived-cache';
import { cacheStatus, recordCacheStatus } from './cache-status.js';

const [, , action] = process.argv;
const config = derivedCacheConfig();
if (action === 'status') {
  process.stdout.write(`${JSON.stringify(await cacheStatus(config.root, config.quotaBytes))}\n`);
} else if (action === 'gc') {
  const cache = new DerivedCache(config);
  const before = await cacheStatus(config.root, config.quotaBytes);
  const withinQuota = await cache.gc();
  const after = await cacheStatus(config.root, config.quotaBytes);
  await recordCacheStatus(config.root, 'gc', Math.max(0, before.usedBytes - after.usedBytes));
  process.stdout.write(
    `${JSON.stringify({ withinQuota, ...(await cacheStatus(config.root, config.quotaBytes)) })}\n`,
  );
} else {
  throw new Error('usage: cache status | cache gc');
}
