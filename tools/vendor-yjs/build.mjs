import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const out = new URL('../../vendor/yjs/', import.meta.url);
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['entry.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, outfile: new URL('yjs.js', out).pathname, legalComments: 'none' });

const bytes = readFileSync(new URL('yjs.js', out));
const version = name => JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version;
const sha = createHash('sha256').update(bytes).digest('hex');
writeFileSync(new URL('README.md', out), `# vendor/yjs

Prebuilt ESM bundle of Yjs and friends (D-06). **Do not edit.** Regenerate with \`tools/vendor-yjs\` (\`npm install && npm run build\`).

| package | version |
|---|---|
| yjs | ${version('yjs')} |
| y-protocols | ${version('y-protocols')} |
| lib0 | ${version('lib0')} |

\`yjs.js\` sha256: \`${sha}\`

Exports: \`Y\`, \`syncProtocol\`, \`awarenessProtocol\`, \`encoding\`, \`decoding\`. Only \`collaboration/providers/\` and
\`collaboration/document/yjs_*\` may import it (components never do).
`);
console.log(`yjs.js ${bytes.length} bytes sha256 ${sha}`);
