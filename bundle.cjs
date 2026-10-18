#!/usr/bin/env node
'use strict';

/**
 * Local, dependency-free packager. Reads dist without changing it.
 *   node work/criasom-app-piloto/bundle.cjs --check  (validate only)
 *   node work/criasom-app-piloto/bundle.cjs          (write standalone HTML)
 * Always rerun after the final dist edits. No server, publication or network.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(__dirname, 'dist');
const OUTPUT = path.join(ROOT, 'outputs', 'criasom-piloto-local.html');
const CHECK_ONLY = process.argv.includes('--check');
const knownArgs = new Set(['--check']);
for (const arg of process.argv.slice(2)) {
  if (!knownArgs.has(arg)) throw new Error(`Opção desconhecida: ${arg}`);
}
const snapshots = new Map();
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const slash = value => value.split(path.sep).join('/');
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.json': 'application/json', '.txt': 'text/plain'
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readSnapshot(file) {
  const before = fs.statSync(file);
  const buffer = fs.readFileSync(file);
  const after = fs.statSync(file);
  assert(before.size === after.size && before.mtimeMs === after.mtimeMs,
    `Arquivo alterado durante a leitura. Aguarde e execute novamente: ${file}`);
  snapshots.set(file, { size: after.size, mtimeMs: after.mtimeMs, hash: hash(buffer) });
  return buffer;
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), `Asset com link simbólico não suportado: ${file}`);
      if (entry.isDirectory()) return walkFiles(file);
      assert(entry.isFile(), `Asset não regular: ${file}`);
      return [file];
    });
}

// Escaping every '<' also covers '</script>', '<!--' and HTML script parsing.
function scriptJSON(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function scriptSource(value) {
  return value.replace(/<\/script/gi, '<\\/script');
}

function modelModule(source) {
  const exported = [];
  const body = source.replace(
    /\bexport\s+(?=(?:async\s+)?function\b|(?:const|let|var|class)\b)/g,
    (match, offset) => {
      const declaration = source.slice(offset + match.length);
      const name = /^(?:(?:async\s+)?function\s+|(?:const|let|var|class)\s+)([A-Za-z_$][\w$]*)/.exec(declaration);
      assert(name, 'Declaração exportada não suportada em model.js.');
      exported.push(name[1]);
      return '';
    }
  );
  assert(exported.length > 0 && new Set(exported).size === exported.length,
    'Exports ausentes ou duplicados em model.js.');
  assert(!/^\s*(?:export|import)\s/m.test(body),
    'Sintaxe de módulo adicional em model.js: amplie o empacotador antes de gerar.');
  const expression = `(() => {\n'use strict';\n${body}\nreturn Object.freeze({${exported.join(',')}});\n})()`;
  // Parse only: do not initialize the model or read any real learner state.
  new vm.Script(expression, { filename: 'criasom-model-inline.js' });
  return { expression, exported: new Set(exported) };
}

function applicationModule(source, exports) {
  let imports = 0;
  const body = source.replace(
    /\bimport\s*\{([^}]+)\}\s*from\s*['"]\.\/model\.js['"]\s*;?/g,
    (_, names) => {
      imports++;
      const bindings = names.split(',').map(value => value.trim()).filter(Boolean).map(value => {
        const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(value);
        assert(match && exports.has(match[1]), `Import ausente no modelo: ${value}`);
        return match[2] ? `${match[1]}: ${match[2]}` : match[1];
      });
      return `const {${bindings.join(',')}} = MODEL;`;
    }
  );
  assert(imports === 1, 'Era esperado um import nomeado de ./model.js em app.js.');
  assert(!/^\s*(?:export|import)\s/m.test(body),
    'Outro import/export em app.js ainda depende de recurso externo.');
  assert(/window\.CRIASOM_DATA/.test(body) && /window\.CRIASOM_ASSETS/.test(body),
    'app.js deve usar CRIASOM_DATA e CRIASOM_ASSETS antes dos recursos externos.');
  return body;
}

const html = readSnapshot(path.join(DIST, 'index.html')).toString('utf8');
const stylesheet = readSnapshot(path.join(DIST, 'styles.css')).toString('utf8');
const model = modelModule(readSnapshot(path.join(DIST, 'model.js')).toString('utf8'));
const app = applicationModule(readSnapshot(path.join(DIST, 'app.js')).toString('utf8'), model.exported);
const data = JSON.parse(readSnapshot(path.join(DIST, 'data.json')).toString('utf8').replace(/^\uFEFF/, ''));
const assetDirectory = path.join(DIST, 'assets');
const assetFiles = walkFiles(assetDirectory);
const assets = {};
let rawAssetBytes = 0;
for (const file of assetFiles) {
  const relative = slash(path.relative(DIST, file));
  const bytes = readSnapshot(file);
  rawAssetBytes += bytes.length;
  const uri = `data:${MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,${bytes.toString('base64')}`;
  assets[relative] = uri;
  // The content currently uses assets/..., retain support for ./assets/... too.
}

function localAsset(reference, from = '') {
  const normalized = slash(path.posix.normalize(path.posix.join(from, reference.replace(/^\.\//, ''))));
  assert(assets[normalized], `Asset referenciado, mas ausente no pacote: ${reference}`);
  return assets[normalized];
}

function inspectData(value) {
  if (typeof value === 'string' && /^(?:\.\/)?assets\//.test(value)) localAsset(value);
  else if (Array.isArray(value)) value.forEach(inspectData);
  else if (value && typeof value === 'object') Object.values(value).forEach(inspectData);
}
inspectData(data);
for (const match of app.matchAll(/\basset\(\s*(['"])((?:\.\/)?assets\/[^'"]+)\1\s*\)/g)) {
  localAsset(match[2]);
}

// Include local stylesheet assets too if added later; external URLs remain explicit.
const css = stylesheet.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (full, quote, uri) => {
  if (/^(?:data:|https?:|\/\/|#)/i.test(uri)) return full;
  return `url("${localAsset(uri)}")`;
});
assert(!/<\/style/i.test(css), 'styles.css contém um fechamento de <style> não suportado.');

const bootstrap = `'use strict';\nwindow.CRIASOM_DATA = ${scriptJSON(data)};\n` +
  `window.CRIASOM_ASSETS = ${scriptJSON(assets)};\n` +
  // Resolve ./assets aliases without duplicating large base64 values in HTML.
  `for (const key of Object.keys(window.CRIASOM_ASSETS)) window.CRIASOM_ASSETS['./' + key] = window.CRIASOM_ASSETS[key];\n` +
  `const MODEL = ${model.expression};\n` +
  `(async () => {\n${app}\n})().catch(error => {\n` +
  `console.error('Falha ao iniciar o piloto Criasom', error);\n` +
  `const main = document.querySelector('#main');\n` +
  `if (main) main.textContent = 'Não foi possível iniciar este arquivo de teste. Reabra a versão mais recente do piloto.';\n` +
  `});\n`;
new vm.Script(bootstrap, { filename: 'criasom-piloto-standalone.js' });
const inlineScript = scriptSource(bootstrap);
new vm.Script(inlineScript, { filename: 'criasom-piloto-escaped.js' });
assert(!/<\/script/i.test(inlineScript), 'Fechamento inesperado de script no conteúdo incorporado.');

let cssTags = 0, appTags = 0;
let bundled = html.replace(/<link\b(?=[^>]*\brel\s*=\s*['"]stylesheet['"])(?=[^>]*\bhref\s*=\s*['"](?:\.\/)?styles\.css['"])[^>]*>/gi,
  () => { cssTags++; return `<style>\n${css}\n</style>`; });
bundled = bundled.replace(/<script\b(?=[^>]*\bsrc\s*=\s*['"](?:\.\/)?app\.js['"])[^>]*>\s*<\/script\s*>/gi,
  () => { appTags++; return `<script>\n${inlineScript}\n</script>`; });
assert(cssTags === 1 && appTags === 1, 'index.html deve conter exatamente styles.css e app.js para incorporar.');
// Cover any direct asset references in the initial HTML. Runtime uses asset().
bundled = bundled.replace(/\b(src|href|poster)\s*=\s*(['"])((?:\.\/)?assets\/[^'"]+)\2/gi,
  (_, attribute, quote, uri) => `${attribute}=${quote}${localAsset(uri)}${quote}`);

// Reject a mixed build if a parallel edit completed while this snapshot was read.
for (const [file, snapshot] of snapshots) {
  const current = fs.statSync(file);
  assert(current.size === snapshot.size && current.mtimeMs === snapshot.mtimeMs &&
    hash(fs.readFileSync(file)) === snapshot.hash,
    `Arquivo alterado durante o empacotamento. Execute novamente após a edição: ${file}`);
}
assert(JSON.stringify(walkFiles(assetDirectory)) === JSON.stringify(assetFiles),
  'A lista de assets mudou durante o empacotamento. Execute novamente.');

const bytes = Buffer.byteLength(bundled);
if (!CHECK_ONLY) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const temporary = `${OUTPUT}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bundled, 'utf8');
  fs.renameSync(temporary, OUTPUT);
}
console.log(JSON.stringify({
  mode: CHECK_ONLY ? 'checked_without_writing_output' : 'standalone_written',
  output: CHECK_ONLY ? null : OUTPUT,
  assetCount: assetFiles.length,
  rawAssetBytes,
  htmlBytes: bytes,
  moduleCount: Array.isArray(data.modules) ? data.modules.length : null,
  syntaxChecked: true,
  sourceSnapshotStable: true,
  sourceFilesChanged: false,
  browserRuntimeTested: false
}, null, 2));
