'use strict';

/**
 * Checagem de sintaxe/normalidade de todos os arquivos JavaScript do projeto.
 * Não depende de cloudflared instalado — seguro para rodar em CI.
 *
 * Uso: node scripts/lint.js
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['src', 'scripts'];
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full);
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}

let failures = 0;

for (const file of files.sort()) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  ok   ${file}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${file}`);
    console.log(String(error.stderr || error.message).split('\n').slice(0, 4).join('\n'));
  }
}

// Os arquivos do renderer rodam em contexto de navegador: `require`/`module`
// não existem lá, então apenas a sintaxe é verificada (feito acima).
console.log(`\n== ${files.length - failures} arquivo(s) ok, ${failures} com erro ==\n`);
process.exit(failures === 0 ? 0 : 1);
