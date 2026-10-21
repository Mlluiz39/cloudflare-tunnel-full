'use strict';

const fs = require('fs');
const https = require('https');

const { CERT_FILE } = require('./paths');

/**
 * Acesso à API da Cloudflare usando o token que vive no `cert.pem` gerado por
 * `cloudflared tunnel login`.
 *
 * Importante: esse token é de escopo curto — ele enxerga apenas a zona
 * escolhida durante o login. Isso é o que permite a interface dizer, com
 * segurança, quais domínios estão realmente autorizados.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

function readCertData() {
  try {
    const raw = fs.readFileSync(CERT_FILE, 'utf8');
    const body = raw
      .split('\n')
      .filter((line) => !line.startsWith('-----'))
      .join('')
      .trim();
    const parsed = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    if (!parsed || !parsed.apiToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

function apiRequest(pathname, { token, method = 'GET', body = null, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const url = new URL(`${API_BASE}${pathname}`);
    const payload = body ? JSON.stringify(body) : null;

    const request = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method,
      timeout,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300 && parsed.success !== false,
            status: response.statusCode,
            result: parsed.result,
            errors: parsed.errors || [],
            raw: data.slice(0, 500),
          });
        } catch {
          resolve({
            ok: false,
            status: response.statusCode,
            result: null,
            errors: [{ message: `Resposta não-JSON (HTTP ${response.statusCode})` }],
            raw: data.slice(0, 500),
          });
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('Tempo esgotado na API da Cloudflare')));
    request.on('error', (error) => resolve({
      ok: false,
      status: 0,
      result: null,
      errors: [{ message: error.message }],
    }));

    if (payload) request.write(payload);
    request.end();
  });
}

function firstErrorMessage(response) {
  const first = response && Array.isArray(response.errors) ? response.errors[0] : null;
  if (!first) return null;
  return first.message || JSON.stringify(first);
}

class CloudflareAPI {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
  }

  /** Metadados do certificado (sem expor o token). */
  certInfo() {
    const data = readCertData();
    if (!data) return { available: false, zoneID: null, accountID: null };
    return {
      available: true,
      zoneID: data.zoneID || null,
      accountID: data.accountID || null,
    };
  }

  _token() {
    const data = readCertData();
    return data ? data.apiToken : null;
  }

  /**
   * Zonas que o token do cert.pem consegue administrar.
   * Normalmente é exatamente uma: a escolhida no login.
   */
  async zones() {
    const token = this._token();
    if (!token) {
      return {
        ok: false,
        zones: [],
        error: 'Sem cert.pem: faça login para descobrir os domínios disponíveis.',
      };
    }

    const response = await apiRequest('/zones?per_page=50', { token });
    if (!response.ok) {
      return {
        ok: false,
        zones: [],
        error: firstErrorMessage(response) || 'Não foi possível listar as zonas.',
      };
    }

    const zones = (response.result || []).map((zone) => ({
      id: zone.id,
      name: zone.name,
      status: zone.status,
    }));

    return { ok: true, zones, error: null };
  }

  /** Registros DNS de um hostname específico dentro da zona autorizada. */
  async dnsRecordsFor(hostname) {
    const token = this._token();
    const { zoneID } = this.certInfo();
    if (!token || !zoneID) {
      return { ok: false, records: [], error: 'Sem certificado de autenticação.' };
    }

    const response = await apiRequest(
      `/zones/${zoneID}/dns_records?name=${encodeURIComponent(hostname)}`,
      { token },
    );
    if (!response.ok) {
      return {
        ok: false,
        records: [],
        error: firstErrorMessage(response) || 'Não foi possível consultar o DNS.',
      };
    }

    return {
      ok: true,
      records: (response.result || []).map((record) => ({
        id: record.id,
        type: record.type,
        name: record.name,
        content: record.content,
        proxied: record.proxied,
      })),
      error: null,
    };
  }

  /**
   * Diz se o hostname pertence a uma zona autorizada pelo cert atual.
   * Usado para avisar antes de tentar criar DNS que vai falhar.
   */
  async checkHostnameAuthority(hostname) {
    const zonesResult = await this.zones();
    if (!zonesResult.ok) {
      return { known: false, authorized: false, zones: [], error: zonesResult.error };
    }

    const zones = zonesResult.zones;
    const lower = String(hostname || '').toLowerCase();
    const match = zones.find((zone) => lower === zone.name.toLowerCase()
      || lower.endsWith(`.${zone.name.toLowerCase()}`));

    return {
      known: true,
      authorized: Boolean(match),
      zone: match || null,
      zones,
      error: null,
    };
  }
}

module.exports = { CloudflareAPI, readCertData, apiRequest };
