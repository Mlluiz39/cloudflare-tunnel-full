'use strict';

const yaml = require('js-yaml');

/**
 * Utilidades de YAML do cloudflared.
 *
 * A leitura usa js-yaml (seguro, sem tags executáveis). A escrita é feita
 * por transformação de texto — não por re-serialização — para preservar
 * comentários e a formatação que o usuário já tinha no arquivo.
 */

const CATCH_ALL_RE = /^(\s*)-\s*service:\s*["']?http_status:404["']?\s*$/;

function normalizeService(route) {
  if (route && typeof route.service === 'string' && route.service.trim()) {
    return route.service.trim();
  }
  const scheme = (route && route.scheme) || 'http';
  const port = route && route.port;
  if (port) return `${scheme}://127.0.0.1:${port}`;
  return 'http_status:404';
}

function routeToLines(route, indent, subIndent) {
  const lines = [];
  const hostname = route && route.hostname ? String(route.hostname).trim() : '';
  const pathValue = route && route.path ? String(route.path).trim() : '';
  const service = normalizeService(route);

  if (hostname) {
    lines.push(`${indent}- hostname: ${hostname}`);
    if (pathValue && pathValue !== '/') lines.push(`${subIndent}path: ${pathValue}`);
    lines.push(`${subIndent}service: ${service}`);
  } else {
    lines.push(`${indent}- service: ${service}`);
  }
  return lines;
}

/** Monta o arquivo de configuração inicial de um túnel. */
function buildConfigText({ tunnelId, credentialsFile, routes = [] }) {
  const lines = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    '',
    'ingress:',
  ];

  const list = Array.isArray(routes) ? routes : [];
  const catchAllIndex = list.findIndex((route) => route && !route.hostname);
  const mainRoutes = catchAllIndex === -1 ? list : list.slice(0, catchAllIndex);
  const customCatchAll = catchAllIndex === -1 ? null : list[catchAllIndex];

  for (const route of mainRoutes) {
    lines.push(...routeToLines(route, '  ', '    '));
  }

  // Uma regra sem hostname casa com tudo e precisa ser a última; se o usuário
  // informou uma, ela substitui o 404 padrão (ter as duas seria inválido).
  if (customCatchAll) {
    lines.push(...routeToLines(customCatchAll, '  ', '    '));
  } else {
    lines.push('  - service: http_status:404');
  }

  lines.push('');
  return lines.join('\n');
}

/** Lê o YAML e devolve algo previsível, sem lançar. */
function parseConfig(text) {
  try {
    const data = yaml.load(text);
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'O arquivo não é um YAML de objeto.', data: null, ingress: [] };
    }
    const ingress = Array.isArray(data.ingress) ? data.ingress : [];
    return {
      ok: true,
      data,
      tunnelId: data.tunnel || data['tunnel'] || null,
      credentialsFile: data['credentials-file'] || data.credentialsFile || null,
      ingress: ingress.map((rule) => ({
        hostname: rule && rule.hostname ? String(rule.hostname) : null,
        path: rule && rule.path ? String(rule.path) : null,
        service: rule && rule.service ? String(rule.service) : null,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message.split('\n')[0],
      data: null,
      ingress: [],
    };
  }
}

/**
 * Validação estrutural antes de chamar o cloudflared.
 * Pega os erros clássicos sem depender de rede.
 */
function validateConfigText(text) {
  const problems = [];
  const parsed = parseConfig(text);

  if (!parsed.ok) {
    return { ok: false, problems: [`YAML inválido: ${parsed.error}`], parsed };
  }

  if (!parsed.tunnelId) problems.push('Falta a chave "tunnel:" com o UUID do túnel.');
  if (!parsed.credentialsFile) problems.push('Falta a chave "credentials-file:".');

  const rawIngress = parsed.data && parsed.data.ingress;
  if (!Array.isArray(rawIngress) || rawIngress.length === 0) {
    problems.push('A seção "ingress:" precisa ter pelo menos a regra final http_status:404.');
  } else {
    const last = rawIngress[rawIngress.length - 1] || {};
    const lastService = String(last.service || '');
    if (last.hostname || last.path) {
      problems.push(
        'A última regra precisa casar com todas as URLs (sem hostname nem path); '
        + `encontrado "${last.hostname || last.path}" em ${lastService || 'regra sem service'}.`,
      );
    }
    rawIngress.forEach((rule, index) => {
      if (!rule || typeof rule !== 'object') {
        problems.push(`Regra ${index + 1} do ingress está vazia.`);
        return;
      }
      if (!rule.service) {
        problems.push(`Regra ${index + 1} não tem "service:".`);
      }
      if (rule.hostname && !rule.service) {
        problems.push(`Regra ${index + 1} (${rule.hostname}) não tem destino.`);
      }
      // Regra sem hostname casa com tudo: só pode ser a última.
      if (!rule.hostname && index !== rawIngress.length - 1) {
        problems.push(
          `Regra ${index + 1} não tem hostname e por isso captura todas as requisições; `
          + 'ela precisa ser a última (depois dela nada é avaliado).',
        );
      }
    });
  }

  return { ok: problems.length === 0, problems, parsed };
}

function ingressIndent(lines) {
  for (const line of lines) {
    const match = /^(\s*)-\s+\S/.exec(line);
    if (match) return match[1];
  }
  return '  ';
}

/**
 * Insere uma rota no YAML preservando o restante do arquivo.
 * A regra catch-all é mantida sempre por último.
 */
function insertRoute(text, route) {
  const base = String(text || '').replace(/\s*$/, '');
  const lines = base.split('\n');
  const ingressIndex = lines.findIndex((line) => /^ingress:\s*$/.test(line));

  if (ingressIndex === -1) {
    const block = ['', 'ingress:', ...routeToLines(route, '  ', '    '), '  - service: http_status:404'];
    return `${base}\n${block.join('\n')}\n`;
  }

  // Índice da última linha não vazia.
  let lastContent = lines.length - 1;
  while (lastContent > ingressIndex && lines[lastContent].trim() === '') lastContent -= 1;

  const body = lines.slice(ingressIndex + 1, lastContent + 1);
  const indent = ingressIndent(body);
  const newLines = routeToLines(route, indent, `${indent}  `);

  const catchAllOffset = body.findIndex((line) => CATCH_ALL_RE.test(line));
  const insertAt = catchAllOffset === -1
    ? lastContent + 1
    : ingressIndex + 1 + catchAllOffset;

  const result = [...lines];
  result.splice(insertAt, 0, ...newLines);
  return `${result.join('\n').replace(/\s*$/, '')}\n`;
}

/**
 * Remove a regra que casa com o hostname (ou o índice informado).
 * Remove também as linhas filhas (path/service) daquela regra.
 */
function removeRoute(text, { hostname, index } = {}) {
  const lines = String(text || '').split('\n');
  const ingressIndex = lines.findIndex((line) => /^ingress:\s*$/.test(line));
  if (ingressIndex === -1) return { ok: false, error: 'Arquivo sem seção ingress.' };

  const starts = [];
  for (let i = ingressIndex + 1; i < lines.length; i += 1) {
    if (/^\s*-\s+\S/.test(lines[i])) starts.push(i);
  }
  if (starts.length === 0) return { ok: false, error: 'Nenhuma regra encontrada.' };

  let target = -1;
  if (typeof index === 'number' && index >= 0 && index < starts.length) {
    target = starts[index];
  } else if (hostname) {
    target = starts.find((start) => new RegExp(`^\\s*-\\s*hostname:\\s*["']?${escapeRegExp(hostname)}["']?\\s*$`).test(lines[start]));
  }
  if (target === undefined || target === -1) {
    return { ok: false, error: 'Regra não encontrada.' };
  }

  const nextStart = starts.find((start) => start > target);
  const end = nextStart === undefined ? lines.length : nextStart;
  lines.splice(target, end - target);

  return { ok: true, text: `${lines.join('\n').replace(/\s*$/, '')}\n` };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lista de rotas "de verdade" (ignora o catch-all). */
function listRoutes(text) {
  const parsed = parseConfig(text);
  if (!parsed.ok) return [];
  return parsed.ingress.filter((rule, idx, arr) => {
    if (rule.hostname) return true;
    // mantém catch-alls não-404 (ex.: service: https://...)
    const isLast = idx === arr.length - 1;
    return !isLast && Boolean(rule.service);
  });
}

module.exports = {
  buildConfigText,
  parseConfig,
  validateConfigText,
  insertRoute,
  removeRoute,
  listRoutes,
  normalizeService,
  routeToLines,
};
