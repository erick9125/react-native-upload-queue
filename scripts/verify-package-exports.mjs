import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);

const esmEntry = join(root, pkg.exports['.'].import.default);
const cjsEntry = join(root, pkg.exports['.'].require.default);

await import(pathToFileURL(esmEntry).href);
require(cjsEntry);

console.log('Package exports verified for ESM and CJS.');
