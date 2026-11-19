import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { verifyPublicMessagingPages } from './verify-public-messaging-pages.mjs';

async function serve(t, fallbackAsset) {
  const server = createServer(async (req, res) => {
    const name = req.url.slice(1);
    if (name === fallbackAsset) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><title>MogulForge Growth OS</title><div id="root"></div></html>');
      return;
    }
    const bytes = await readFile(new URL(`../artifacts/command-center/public/${name}`, import.meta.url));
    const mime = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('verifies the three distinct pages and both dependencies over HTTP', async t => {
  const records = await verifyPublicMessagingPages({ origin: await serve(t) });
  assert.equal(records.length, 5);
  assert.equal(new Set(records.map(record => record.sha256)).size, 5);
});

for (const name of ['messaging-privacy.html', 'messaging-terms.html', 'sms-preferences.html', 'messaging.css', 'sms-preferences.js']) {
  test(`rejects HTTP 200 SPA fallback at ${name}`, async t => {
    await assert.rejects(verifyPublicMessagingPages({ origin: await serve(t, name) }), /differs from the reviewed asset|incorrect content type/);
  });
}
