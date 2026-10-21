'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns').promises;

/**
 * Verificações usadas pela interface para dar feedback visual imediato:
 *  - o serviço local está no ar?
 *  - o hostname já resolve (CNAME para .cfargotunnel.com)?
 *  - o hostname público responde HTTPS?
 */

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/** Consulta DNS over HTTPS (evita cache negativo do resolver local). */
function dohQuery(name, type = 'CNAME', { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const url = new URL(DOH_ENDPOINT);
    url.searchParams.set('name', name);
    url.searchParams.set('type', type);

    const request = https.get(url, {
      timeout,
      headers: { accept: 'application/dns-json' },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          const answers = (parsed.Answer || []).map((answer) => ({
            type: answer.type,
            data: answer.data,
          }));
          resolve({
            ok: true,
            status: parsed.Status,
            // Status 3 = NXDOMAIN (não existe)
            exists: parsed.Status === 0 && answers.length > 0,
            answers,
            target: (answers.find((a) => a.type === 5) || {}).data || null,
          });
        } catch {
          resolve({ ok: false, error: 'Resposta DNS inválida.' });
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('Tempo esgotado na consulta DNS')));
    request.on('error', (error) => resolve({ ok: false, error: error.message }));
  });
}

/** O hostname resolve no DNS público? (CNAME para <uuid>.cfargotunnel.com) */
async function checkHostname(hostname) {
  const cname = await dohQuery(hostname, 'CNAME');
  if (cname.ok && cname.exists) {
    return {
      ok: true,
      resolves: true,
      target: cname.target,
      tunneled: Boolean(cname.target && cname.target.includes('cfargotunnel.com')),
      error: null,
    };
  }

  // Sem CNAME visível pode haver A/AAAA. Isso acontece tanto para um registro
  // antigo quanto para um CNAME proxied (nuvem laranja), onde a Cloudflare
  // responde com IPs próprios e o CNAME não aparece publicamente.
  const address = await dohQuery(hostname, 'A');
  if (address.ok && address.exists) {
    const data = address.answers.map((a) => a.data).join(', ');
    return {
      ok: true,
      resolves: true,
      target: data,
      // null = indefinido a partir do DNS público; a API do Cloudflare (quando
      // disponível) é quem diz se o hostname aponta para o túnel.
      tunneled: null,
      error: null,
      note: 'O hostname resolve para IPs da própria Cloudflare (registro proxied) ou para outro destino.',
    };
  }

  if (!cname.ok) return { ok: false, resolves: false, error: cname.error };
  return { ok: true, resolves: false, target: null, tunneled: false, error: null };
}

/** Faz um GET simples e devolve status/erro, sem baixar o corpo inteiro. */
function httpGet(target, { timeout = 8000, rejectUnauthorized = false } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(target);
    } catch {
      resolve({ ok: false, error: `URL inválida: ${target}` });
      return;
    }

    const client = url.protocol === 'https:' ? https : http;
    const started = Date.now();
    const request = client.get(url, {
      timeout,
      rejectUnauthorized,
      headers: { 'User-Agent': 'cloudflare-tunnel-manager', Accept: '*/*' },
    }, (response) => {
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 400,
        status: response.statusCode,
        elapsedMs: Date.now() - started,
        error: response.statusCode >= 400 ? `HTTP ${response.statusCode}` : null,
      });
      response.resume();
    });

    request.on('timeout', () => request.destroy(new Error('Tempo esgotado')));
    request.on('error', (error) => resolve({
      ok: false,
      status: 0,
      elapsedMs: Date.now() - started,
      error: error.code === 'ENOTFOUND'
        ? 'DNS ainda não resolve (pode levar alguns segundos após criar o registro).'
        : error.message,
    }));
  });
}

/** Há algo escutando na porta local e respondendo HTTP? */
async function checkLocalService({ port, scheme = 'http', host = '127.0.0.1' }) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return { listening: false, error: 'Porta inválida.' };
  }

  // 1) A porta está aberta?
  const open = await new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(3000);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(numericPort, host);
  });

  if (!open) {
    return {
      listening: false,
      error: `Nada escutando em ${host}:${numericPort}. Suba seu serviço antes de publicar.`,
    };
  }

  // 2) Responde HTTP? (o túnel aceita http/https, mas sinaliza se não for HTTP)
  const target = `${scheme}://${host}:${numericPort}/`;
  const probe = await httpGet(target, { timeout: 6000 });
  if (probe.ok) {
    return {
      listening: true, httpStatus: probe.status, elapsedMs: probe.elapsedMs, error: null,
    };
  }

  return {
    listening: true,
    httpStatus: probe.status || null,
    error: null,
    warning: probe.error
      ? `A porta está aberta, mas ${target} respondeu: ${probe.error}`
      : null,
  };
}

/**
 * Espera o DNS propagar e testa o hostname público.
 * Tenta algumas vezes porque o registro leva alguns segundos para aparecer.
 */
async function waitForPublicHostname(hostname, { attempts = 5, delayMs = 2500 } = {}) {
  let lastDns = { resolves: false };
  let lastHttp = { ok: false };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastDns = await checkHostname(hostname);
    if (lastDns.resolves) {
      lastHttp = await httpGet(`https://${hostname}/`);
      if (lastHttp.ok) {
        return {
          ok: true,
          attempts: attempt,
          dns: lastDns,
          http: lastHttp,
        };
      }
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return {
    ok: false,
    attempts,
    dns: lastDns,
    http: lastHttp,
    error: lastDns.resolves
      ? `O DNS já resolve, mas o HTTPS respondeu: ${lastHttp.error || 'sem resposta'}`
      : 'O DNS ainda não propagou. Costuma levar de segundos a poucos minutos.',
  };
}

/** Verifica se o hostname está autorizado pela Cloudflare (resolução via sistema). */
async function systemResolve(hostname) {
  try {
    const records = await dns.resolve4(hostname);
    return { ok: true, addresses: records };
  } catch (error) {
    return { ok: false, error: error.code || error.message };
  }
}

module.exports = {
  dohQuery,
  checkHostname,
  checkLocalService,
  httpGet,
  waitForPublicHostname,
  systemResolve,
};
