import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const apps = ['frontend', 'backend', 'worker', 'ranker'];
const manifests = Object.fromEntries(apps.map(name => [name, JSON.parse(readFileSync(`apps/${name}/package.json`, 'utf8'))]));
const common = ['contracts', 'documents', 'data-access'];
const sources = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(directory, entry.name)] : []);
for (const name of [...apps, ...common]) {
  const directory = resolve(apps.includes(name) ? `apps/${name}` : `packages/${name}`);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const allowed = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    if (dependency.startsWith('@hr/')) assert.ok(common.includes(dependency.slice(4)), `${name}: application package dependency ${dependency}`);
  }
  if (name === 'contracts') assert.ok(!Object.keys(manifest.dependencies || {}).some(dependency => dependency.startsWith('@hr/')), 'contracts must not depend on server packages');
  for (const file of sources(join(directory, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const imported = match[1];
      if (name === 'frontend' || name === 'contracts') assert.ok(!imported.startsWith('node:'), `${file}: Node.js import in browser package`);
      if (imported.startsWith('.')) {
        assert.ok(!relative(directory, resolve(file, '..', imported)).startsWith('..'), `${file}: cross-package source import ${imported}`);
      } else if (!imported.startsWith('node:')) {
        const dep = imported.startsWith('@') ? imported.split('/').slice(0, 2).join('/') : imported.split('/')[0];
        assert.ok(allowed.has(dep), `${file}: undeclared dependency ${dep}`);
      }
    }
  }
}
assert.deepEqual(Object.keys(manifests.frontend.dependencies).filter(name => name.startsWith('@hr/')), ['@hr/contracts']);
for (const name of ['pg', '@aws-sdk/client-s3', 'express', 'multer', 'pdfjs-dist']) assert.ok(!(name in manifests.frontend.dependencies), `frontend contains ${name}`);
assert.equal(Object.keys(JSON.parse(readFileSync('package.json','utf8')).dependencies || {}).length, 0);
for (const app of apps) assert.ok(readFileSync(`apps/${app}/Dockerfile`, 'utf8').includes(`apps/${app}`));
assert.ok(!readFileSync('apps/backend/src/index.ts', 'utf8').includes('express.static'));
console.log('Architecture: isolated application imports, declared dependencies, browser-only frontend and separate Dockerfiles passed');
