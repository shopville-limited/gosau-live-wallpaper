// Zkontroluje syntaxi všech skriptů projektu (node --check).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const skip = new Set(['node_modules', 'build', '.git', '.playwright-mcp', 'out']);
const files = [];
(function walk(folder) {
  for (const name of readdirSync(folder)) {
    if (skip.has(name)) continue;
    const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(m?js)$/.test(name)) files.push(path);
  }
})(project);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`v pořádku  ${relative(project, file)}`);
  } catch (error) {
    failed++;
    console.log(`CHYBA      ${relative(project, file)}\n${error.stderr}`);
  }
}
console.log(failed ? `${failed} souborů s chybou` : `Všech ${files.length} souborů je v pořádku.`);
process.exit(failed ? 1 : 0);
