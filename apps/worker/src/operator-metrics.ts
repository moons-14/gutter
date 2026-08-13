import { createServer } from 'node:http';
import { statfs } from 'node:fs/promises';
import { cacheStatus } from './cache-status.js';

type QueryPool = { query: <T>(sql: string) => Promise<{ rows: T[] }> };

const states = ['queued', 'dispatched', 'running', 'completed', 'failed', 'cancelled'] as const;
const metric = (name: string, value: number, labels = '') =>
  `${name}${labels} ${Number.isFinite(value) ? Math.max(0, value) : 0}\n`;

/** Internal-only worker surface: bounded state and filesystem capacity, never paths or keys. */
export function startOperatorMetricsServer(options: {
  pool: QueryPool;
  cacheRoot: string;
  cacheQuotaBytes: number;
  port?: number;
  signal: AbortSignal;
}) {
  const server = createServer(async (request, response) => {
    if (request.url === '/health') return void response.writeHead(200).end('ok\n');
    if (request.url === '/ready') {
      try {
        await options.pool.query("select 1 from gutter_schema where version='0010_user_state'");
        await options.pool.query('select 1 from pgboss.job limit 1');
        const cache = await cacheStatus(options.cacheRoot, options.cacheQuotaBytes);
        if (cache.quotaBytes < 1) throw new Error('invalid_cache_quota');
        response.writeHead(200).end('ready\n');
      } catch {
        response.writeHead(503).end('not-ready\n');
      }
      return;
    }
    if (request.url !== '/metrics') return void response.writeHead(404).end();
    try {
      const cache = await cacheStatus(options.cacheRoot, options.cacheQuotaBytes);
      const fs = await statfs(options.cacheRoot).catch(() => null);
      const queued = await options.pool.query<{ state: string; count: string }>(
        'select state,count(*) from scan_requests group by state',
      );
      const lines = [
        '# HELP gutter_worker_cache_used_bytes Current disposable cache bytes.\n# TYPE gutter_worker_cache_used_bytes gauge\n',
        metric('gutter_worker_cache_used_bytes', cache.usedBytes),
        '# HELP gutter_worker_cache_quota_bytes Configured disposable cache quota.\n# TYPE gutter_worker_cache_quota_bytes gauge\n',
        metric('gutter_worker_cache_quota_bytes', cache.quotaBytes),
        '# HELP gutter_worker_cache_free_bytes Filesystem free bytes at the cache mount.\n# TYPE gutter_worker_cache_free_bytes gauge\n',
        metric('gutter_worker_cache_free_bytes', fs ? Number(fs.bavail) * Number(fs.bsize) : 0),
        '# HELP gutter_worker_scan_requests Scan requests by bounded state.\n# TYPE gutter_worker_scan_requests gauge\n',
        ...states.map((state) =>
          metric(
            'gutter_worker_scan_requests',
            Number(queued.rows.find((row) => row.state === state)?.count ?? 0),
            `{state="${state}"}`,
          ),
        ),
      ];
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(lines.join(''));
    } catch {
      response.writeHead(503).end('metrics unavailable\n');
    }
  });
  server.listen(options.port ?? 9090, '0.0.0.0');
  options.signal.addEventListener('abort', () => server.close(), { once: true });
  return server;
}
