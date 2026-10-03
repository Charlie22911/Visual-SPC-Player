import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(projectRoot, 'dist');
const outputPath = join(projectRoot, 'Visual-SPC-Player.html');

const asBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const escapeScript = (text) => text
  .replace(/<\/script/gi, '<\\/script')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');
const escapeStyle = (text) => text.replace(/<\/style/gi, '<\\/style');

const assetPath = (url) => {
  const normalized = url.replace(/^\.\//, '').replace(/^\//, '').split(/[?#]/, 1)[0];
  if (!normalized) throw new Error(`Unsafe build asset path: ${url}`);
  const path = resolve(distRoot, ...normalized.split('/'));
  const fromDist = relative(distRoot, path);
  if (fromDist === '..' || fromDist.startsWith(`..\\`) || fromDist.startsWith('../') || isAbsolute(fromDist)) {
    throw new Error(`Build asset leaves dist: ${url}`);
  }
  return path;
};

const exactlyOne = (values, label) => {
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error(`Expected exactly one ${label}; found ${unique.length}`);
  return unique[0];
};

const indexHtml = await readFile(join(distRoot, 'index.html'), 'utf8');
const scriptSources = [...indexHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*><\/script>/gi)]
  .map((match) => match[1]);
const stylesheetLinks = [...indexHtml.matchAll(/<link\b[^>]*>/gi)]
  .filter((match) => /\brel\s*=\s*"stylesheet"/i.test(match[0]))
  .map((match) => match[0].match(/\bhref\s*=\s*"([^"]+)"/i)?.[1])
  .filter(Boolean);
const mainScriptUrl = exactlyOne(scriptSources, 'compiled application script');
const stylesheetUrl = exactlyOne(stylesheetLinks, 'compiled stylesheet');

const mainScriptPath = assetPath(mainScriptUrl);
const mainJavaScript = await readFile(mainScriptPath, 'utf8');
const css = await readFile(assetPath(stylesheetUrl), 'utf8');
if (/\bimport\s*\(/.test(mainJavaScript)) {
  throw new Error('The compiled application contains a dynamic import and is not a single JavaScript bundle');
}
const externalCssUrls = [...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)]
  .map((match) => match[2])
  .filter((url) => !url.startsWith('data:'));
if (externalCssUrls.length) {
  throw new Error(`The compiled stylesheet still references external assets: ${externalCssUrls.join(', ')}`);
}

const workletReferences = [...mainJavaScript.matchAll(
  /new URL\(\s*([`'"])(spc\.worklet-[A-Za-z0-9_-]+\.js)\1\s*,\s*import\.meta\.url\s*\)/g,
)].map((match) => match[2]);
const workletName = exactlyOne(workletReferences, 'worklet referenced by the application bundle');
const workletPath = resolve(dirname(mainScriptPath), workletName);
const workletSource = await readFile(workletPath, 'utf8');
if (!/registerProcessor\(\s*([`'"])spc-processor\1\s*,/.test(workletSource)) {
  throw new Error('The compiled worklet does not register spc-processor');
}
if (/\bimport\s*(?:\(|[`'"{*])/.test(workletSource)) {
  throw new Error('The compiled worklet contains an unresolved import');
}

const wasm = await readFile(join(distRoot, 'spc_core.wasm'));
const icon = await readFile(join(distRoot, 'icon.svg'));
const notices = [
  await readFile(join(distRoot, 'NOTICE.txt'), 'utf8'),
  '===== Project license =====\n\n' + await readFile(join(distRoot, 'LICENSE.txt'), 'utf8'),
  '===== LGPL-2.1 =====\n\n' + await readFile(join(projectRoot, 'LICENSES', 'LGPL-2.1.txt'), 'utf8'),
  '===== React, React DOM, and Scheduler =====\n\n' + await readFile(join(projectRoot, 'LICENSES', 'React-MIT.txt'), 'utf8'),
].join('\n\n');
const sourceBundle = await readFile(join(distRoot, 'spc-core-source.txt'), 'utf8');
const buildId = createHash('sha256')
  .update(mainJavaScript)
  .update(css)
  .update(workletSource)
  .update(wasm)
  .digest('hex')
  .slice(0, 12);

const standaloneAssets = escapeScript(JSON.stringify({
  workletBase64: asBase64(workletSource),
  wasmBase64: asBase64(wasm),
  noticesBase64: asBase64(notices),
  sourceBase64: asBase64(sourceBundle),
  buildId,
}));
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="description" content="Play local SPC files and inspect live SPC700 memory." />
    <meta name="theme-color" content="#070b14" />
    <meta name="spc-build-id" content="${buildId}" />
    <link rel="icon" href="data:image/svg+xml;base64,${asBase64(icon)}" />
    <title>Visual SPC Player</title>
    <style>${escapeStyle(css)}</style>
  </head>
  <body data-spc-standalone="true" data-spc-build-id="${buildId}">
    <div id="root"></div>
    <script>window.__SPC_STANDALONE_ASSETS__=${standaloneAssets};</script>
    <script type="module">${escapeScript(mainJavaScript)}</script>
  </body>
</html>
`;

await writeFile(outputPath, html);
console.log(`Created ${basename(outputPath)} (${Buffer.byteLength(html).toLocaleString()} bytes, build ${buildId})`);
