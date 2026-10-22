#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const versionFile = resolve(root, 'src', 'version.ts');
const content = `// Injected/synchronized at build time\nexport const SDK_VERSION = '${pkg.version}';\n`;

writeFileSync(versionFile, content, 'utf8');
console.log(`Synced SDK_VERSION to ${pkg.version}`);
