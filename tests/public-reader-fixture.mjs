import { createServer } from 'node:http';

const body = Buffer.from('fixture-page-bytes');
const etag = 'W/"public-fixture"';

const server = createServer((request, response) => {
  const conditional = request.headers['if-none-match'];
  if (conditional === 'timeout') {
    setTimeout(() => response.end(), 30_000);
    return;
  }
  if (conditional === 'nonbinary') {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 12 });
    response.end('not-an-image');
    return;
  }
  if (conditional === etag) {
    response.writeHead(304, { ETag: etag, 'Last-Modified': new Date(0).toUTCString() });
    response.end();
    return;
  }
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : Number.POSITIVE_INFINITY;
    const requestedEnd = match?.[2] ? Number(match[2]) : body.length - 1;
    const end = Math.min(requestedEnd, body.length - 1);
    if (!match || !Number.isSafeInteger(start) || start >= body.length || start > end) {
      response.writeHead(416, { 'Content-Range': `bytes */${body.length}`, ETag: etag });
      response.end();
      return;
    }
    const partial = body.subarray(start, end + 1);
    response.writeHead(206, {
      'Content-Type': 'image/png',
      'Content-Length': partial.length,
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      ETag: etag,
    });
    response.end(partial);
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': body.length,
    ETag: etag,
  });
  response.end(body);
});

server.listen(3001, '0.0.0.0');
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));
