import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../artifacts/command-center/public/', import.meta.url));
const assets = [
  ['messaging-privacy.html', /text\/html/i],
  ['messaging-terms.html', /text\/html/i],
  ['sms-preferences.html', /text\/html/i],
  ['messaging.css', /text\/css/i],
  ['sms-preferences.js', /(?:application|text)\/javascript/i],
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Compare actual responses/build output with the reviewed source bytes. A 200
// SPA fallback must fail, including when returned for the CSS or JavaScript.
export async function verifyPublicMessagingPages({ origin, directory } = {}) {
  assert(Boolean(origin) !== Boolean(directory), 'Specify exactly one of origin or directory');
  const records = [];
  for (const [name, contentType] of assets) {
    const expected = await readFile(resolve(sourceDir, name));
    let actual;
    if (origin) {
      const response = await fetch(new URL(`/${name}`, origin), {
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
      });
      assert.equal(response.status, 200, `${name}: expected HTTP 200`);
      assert.match(response.headers.get('content-type') ?? '', contentType, `${name}: incorrect content type`);
      actual = Buffer.from(await response.arrayBuffer());
    } else {
      actual = await readFile(resolve(directory, name));
    }
    assert.equal(sha256(actual), sha256(expected), `${name}: response differs from the reviewed asset (possibly the SPA fallback)`);
    records.push({ path: `/${name}`, bytes: actual.length, sha256: sha256(actual) });
  }
  return records;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [option, value, ...extra] = process.argv.slice(2);
  assert(extra.length === 0 && value && ['--origin', '--directory'].includes(option),
    'Usage: node scripts/verify-public-messaging-pages.mjs --origin https://app.mogulforge.ai | --directory /app/public');
  const records = await verifyPublicMessagingPages(option === '--origin' ? { origin: value } : { directory: value });
  console.log(JSON.stringify(records, null, 2));
}
