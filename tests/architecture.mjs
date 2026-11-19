import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const apps = ['frontend', 'backend', 'auth-check', 'guest-api'];
const manifests = Object.fromEntries(apps.map(name => [name, JSON.parse(readFileSync(`apps/${name}/package.json`, 'utf8'))]));
const common = ['contracts', 'documents', 'data-access', 'security', 'processing'];
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
    assert.doesNotMatch(text, /@hr\/legacy-transport|@hr\/worker/, `${file}: legacy import in current code`);
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
assert.ok(readFileSync('apps/frontend/Dockerfile', 'utf8').includes('apps/frontend'));
assert.ok(!existsSync('apps/backend/Dockerfile'), 'Node services must use the shared Dockerfile');
assert.ok(!existsSync('apps/worker/src') && !existsSync('legacy/worker/package.json'), 'retired worker present');
assert.ok(!existsSync('legacy/transport/package.json'), 'retired transport present');
for (const name of ['auth-check', 'guest-api', 'security', 'processing']) {
  const manifest = JSON.parse(readFileSync(`${apps.includes(name) ? 'apps' : 'packages'}/${name}/package.json`, 'utf8'));
  assert.ok(!manifest.dependencies?.pg && !manifest.dependencies?.['@hr/data-access'], `${name}: database dependency`);
  for (const file of sources(`${apps.includes(name) ? 'apps' : 'packages'}/${name}/src`)) {
    assert.ok(!readFileSync(file, 'utf8').includes('@hr/data-access'), `${file}: business repository import`);
  }
}
assert.ok(!readFileSync('apps/backend/src/index.ts', 'utf8').includes('express.static'));
console.log('Architecture: isolated application imports, declared dependencies, browser-only frontend and separate Dockerfiles passed');
assert.ok(readFileSync('.npmrc', 'utf8').includes('install-strategy=nested'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.ok(!Object.keys(lock.packages).some(path => /^(?:apps\/worker|legacy\/|node_modules\/@hr\/(?:worker|legacy-transport))/.test(path)), 'retired workspaces in lockfile');
for (const dep of ['react', 'react-dom', 'vite']) {
  assert.ok(lock.packages[`apps/frontend/node_modules/${dep}`], `frontend dependency must be installed inside frontend: ${dep}`);
  assert.ok(!lock.packages[`node_modules/${dep}`], `frontend dependency hoisted to root: ${dep}`);
}
assert.ok(readFileSync('apps/frontend/vite.config.ts', 'utf8').indexOf('../../public') === -1);
for (const [service, module] of [['resume-parser', 'resume_parser'], ['resume-evaluator', 'resume_evaluator']]) {
  const dockerfile = readFileSync(`apps/${service}/Dockerfile`, 'utf8');
  assert.ok(dockerfile.includes(`apps/${service}/src/`));
  assert.ok(dockerfile.includes(`"${module}"`));
  assert.ok(!dockerfile.includes('resume-analyzer'));
  assert.ok(!dockerfile.includes(service === 'resume-parser' ? 'apps/resume-evaluator' : 'apps/resume-parser'));
  const requirements = readFileSync(`apps/${service}/requirements.txt`, 'utf8');
  assert.ok(!/fastapi|uvicorn|python-multipart/.test(requirements));
}
assert.ok(!readFileSync('apps/resume-parser/Dockerfile', 'utf8').includes('libreoffice'));
console.log('PASS Python delivery: independent entrypoints, dependency lists and images; retired analyzer excluded');
