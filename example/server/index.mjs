import { createServer } from 'node:http';

const seenKeys = new Map();
const port = Number(process.env.PORT ?? 8787);

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
    ...headers,
  });
  res.end(payload);
}

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url?.startsWith('/uploads')) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const key = req.headers['idempotency-key'];

    if (url.searchParams.has('delay')) {
      await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get('delay'))));
    }

    if (url.searchParams.get('fail') === '500') {
      send(res, 500, { error: 'simulated' });
      return;
    }

    if (url.searchParams.get('fail') === '429') {
      send(res, 429, { error: 'slow down' }, { 'retry-after': '5' });
      return;
    }

    if (url.searchParams.get('close') === '1') {
      req.socket.destroy();
      return;
    }

    if (typeof key === 'string' && seenKeys.has(key)) {
      send(res, 200, seenKeys.get(key));
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const result = {
      id: `remote-${seenKeys.size + 1}`,
      bytes: Buffer.concat(chunks).byteLength,
      idempotencyKey: key ?? null,
    };

    if (typeof key === 'string') {
      seenKeys.set(key, result);
    }

    send(res, 200, result);
    return;
  }

  send(res, 404, { error: 'not found' });
}).listen(port, () => {
  console.log(`upload example server on http://127.0.0.1:${port}/uploads`);
});
