'use strict';

/**
 * Testes do fluxo "Novo subdomínio".
 *
 * A parte de orquestração roda com dublês (fakes) — nada é criado na sua conta
 * Cloudflare nem no systemd. As funções de rede (DNS/HTTP) testam destinos
 * públicos reais.
 *
 * Uso: node scripts/test-publish.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-pub-'));
process.env.CLOUDFLARED_HOME = tempHome;

const configTools = require('../src/main/config');
const { CloudflareAPI } = require('../src/main/cloudflare-api');
const checkup = require('../src/main/checkup');
const { Publisher } = require('../src/main/publish');

let passed = 0;
let failed = 0;

async function checkAsync(label, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

// ------------------------------------------------------------- dublês

function makeFakes({ authorized = true, existingDns = [], localListening = true } = {}) {
  const calls = [];
  const state = {
    tunnelId: null,
    configContent: null,
    dns: [...existingDns],
  };

  // Os dublês gravam arquivos de verdade no tempHome: assim o preflight real
  // (que lê do disco e valida o YAML) é exercitado de ponta a ponta.
  const writeConfigFile = (name, content) => {
    const target = path.join(tempHome, `${name}.yml`);
    fs.writeFileSync(target, content, { mode: 0o600 });
    return target;
  };
  const writeCreds = (id) => {
    const target = path.join(tempHome, `${id}.json`);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, JSON.stringify({ TunnelID: id, TunnelSecret: 'x', AccountTag: 'y' }), { mode: 0o600 });
    }
    return target;
  };

  const api = {
    calls,
    async tunnelIdByName(name) {
      calls.push(`tunnelIdByName:${name}`);
      return state.tunnelId;
    },
    async createTunnel({ name, routes }) {
      calls.push(`createTunnel:${name}:${routes.length}`);
      state.tunnelId = '11111111-2222-3333-4444-555555555555';
      writeCreds(state.tunnelId);
      state.configContent = configTools.buildConfigText({
        tunnelId: state.tunnelId,
        credentialsFile: path.join(tempHome, `${state.tunnelId}.json`),
        routes,
      });
      const configPath = writeConfigFile(name, state.configContent);
      return { ok: true, name, tunnelId: state.tunnelId, configPath };
    },
    async readConfig(name) {
      calls.push(`readConfig:${name}`);
      if (!state.configContent) return { ok: false, error: 'sem config' };
      return { ok: true, content: state.configContent, routes: configTools.listRoutes(state.configContent) };
    },
    async saveConfig(name, content) {
      calls.push(`saveConfig:${name}`);
      const validation = configTools.validateConfigText(content);
      if (!validation.ok) return { ok: false, error: validation.problems.join('\n') };
      state.configContent = content;
      return { ok: true, path: writeConfigFile(name, content), routes: configTools.listRoutes(content) };
    },
    async scaffoldConfig({ name, routes = [] }) {
      calls.push(`scaffoldConfig:${name}`);
      state.tunnelId = state.tunnelId || 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      writeCreds(state.tunnelId);
      state.configContent = configTools.buildConfigText({
        tunnelId: state.tunnelId,
        credentialsFile: path.join(tempHome, `${state.tunnelId}.json`),
        routes,
      });
      return { ok: true, path: writeConfigFile(name, state.configContent), hasCredentials: true };
    },
    async routeDNS({ tunnel, hostname }) {
      calls.push(`routeDNS:${tunnel}:${hostname}`);
      state.dns.push({
        type: 'CNAME', name: hostname, content: `${state.tunnelId}.cfargotunnel.com`, proxied: true,
      });
      return { ok: true };
    },
    async validateConfigFile() {
      calls.push('validateConfigFile');
      return { ok: true, output: 'OK' };
    },
  };

  const cloudflare = {
    calls,
    async checkHostnameAuthority(hostname) {
      calls.push(`checkHostnameAuthority:${hostname}`);
      if (!authorized) {
        return {
          known: true,
          authorized: false,
          zones: [{ name: 'outro-dominio.com', status: 'active' }],
          error: null,
        };
      }
      return {
        known: true, authorized: true, zones: [{ name: 'exemplo.com', status: 'active' }], error: null,
      };
    },
    async dnsRecordsFor(hostname) {
      calls.push(`dnsRecordsFor:${hostname}`);
      return { ok: true, records: state.dns.filter((record) => record.name === hostname) };
    },
  };

  const services = {
    calls,
    async startOrInstall(name) {
      calls.push(`startOrInstall:${name}`);
      return { ok: true };
    },
    async enable(name) {
      calls.push(`enable:${name}`);
      return { ok: true, linger: { ok: true } };
    },
  };

  const checker = {
    calls,
    async checkLocalService({ port }) {
      calls.push(`checkLocalService:${port}`);
      return localListening
        ? { listening: true, httpStatus: 200, elapsedMs: 5, error: null }
        : { listening: false, error: 'nada escutando' };
    },
    async waitForPublicHostname(hostname) {
      calls.push(`waitForPublicHostname:${hostname}`);
      return { ok: true, dns: { resolves: true, target: 'x.cfargotunnel.com' }, http: { status: 200, elapsedMs: 12 } };
    },
  };

  return { api, cloudflare, services, checker, state, calls };
}

function stepOf(result, id) {
  return (result.steps || []).find((step) => step.id === id);
}

async function main() {
  console.log('\n== cert.pem (leitura do token) ==');
  const fakeCert = Buffer.from(JSON.stringify({
    zoneID: 'zone-123', accountID: 'acc-456', apiToken: 'token-falso',
  })).toString('base64');

  await checkAsync('certInfo ausente sem arquivo', async () => {
    const api = new CloudflareAPI();
    const info = api.certInfo();
    assert.strictEqual(info.available, false);
    return 'available=false';
  });

  fs.writeFileSync(path.join(tempHome, 'cert.pem'), `-----BEGIN ARGO TUNNEL TOKEN-----\n${fakeCert}\n-----END ARGO TUNNEL TOKEN-----\n`, { mode: 0o600 });

  await checkAsync('certInfo lê zoneID/accountID', async () => {
    const api = new CloudflareAPI();
    const info = api.certInfo();
    assert.ok(info.available, 'deveria estar disponível');
    assert.strictEqual(info.zoneID, 'zone-123');
    assert.strictEqual(info.accountID, 'acc-456');
    return `${info.zoneID} / ${info.accountID}`;
  });

  await checkAsync('zones() falha de forma limpa com token inválido', async () => {
    const api = new CloudflareAPI();
    const res = await api.zones();
    assert.strictEqual(res.ok, false, 'token falso não deveria funcionar');
    assert.ok(res.error, 'deveria trazer mensagem de erro');
    return res.error.slice(0, 70);
  });

  console.log('\n== checagens reais (rede) ==');
  await checkAsync('DoH resolve cloudflare.com', async () => {
    const res = await checkup.dohQuery('cloudflare.com', 'A');
    assert.ok(res.ok && res.exists, JSON.stringify(res));
    return `${res.answers.length} registro(s)`;
  });

  await checkAsync('checkHostname: example.com resolve mas não é túnel', async () => {
    const res = await checkup.checkHostname('example.com');
    assert.ok(res.resolves === true, JSON.stringify(res));
    // tunneled=null: o DNS público não distingue proxied de outro destino.
    assert.strictEqual(res.tunneled, null);
    return 'resolves=true, tunneled=null (indefinido no DNS público)';
  });

  await checkAsync('checkHostname: domínio inexistente não resolve', async () => {
    // .invalid é reservado e nunca resolve (não há wildcard)
    const res = await checkup.checkHostname('nao-existe-mesmo-12345.invalid');
    assert.strictEqual(res.resolves, false, JSON.stringify(res));
    return 'resolves=false';
  });

  await checkAsync('checkLocalService detecta porta fechada', async () => {
    const res = await checkup.checkLocalService({ port: 8099 });
    assert.strictEqual(res.listening, false);
    return 'listening=false';
  });

  await checkAsync('checkLocalService rejeita porta inválida', async () => {
    const res = await checkup.checkLocalService({ port: 99999 });
    assert.strictEqual(res.listening, false);
    assert.ok(res.error);
    return res.error;
  });

  console.log('\n== publicar: caminho feliz (fakes) ==');
  await checkAsync('cria túnel, ingress, DNS, serviço e testa', async () => {
    const fakes = makeFakes();
    const publisher = new Publisher({
      api: fakes.api, cloudflare: fakes.cloudflare, services: fakes.services, checker: fakes.checker,
    });

    const result = await publisher.publishSubdomain({
      subdomain: 'api',
      domain: 'exemplo.com',
      port: 3000,
      scheme: 'http',
      tunnelMode: 'new',
      createDns: true,
      startService: true,
    });

    assert.ok(result.ok, JSON.stringify(result.steps));
    assert.strictEqual(result.hostname, 'api.exemplo.com');
    assert.strictEqual(result.url, 'https://api.exemplo.com');

    for (const id of ['input', 'zone', 'local', 'tunnel', 'config', 'dns', 'service', 'probe']) {
      const step = stepOf(result, id);
      assert.ok(step, `passo ${id} ausente`);
      assert.ok(['ok', 'warn', 'skipped'].includes(step.state), `passo ${id} terminou em ${step.state}`);
    }
    assert.ok(fakes.calls.some((c) => c.startsWith('createTunnel:api')), 'não criou o túnel');
    assert.ok(fakes.calls.some((c) => c === 'routeDNS:api:api.exemplo.com'), 'não criou o DNS');
    assert.ok(fakes.calls.some((c) => c === 'startOrInstall:api'), 'não iniciou o serviço');
    return `${result.steps.filter((s) => s.state === 'ok').length} passos ok`;
  });

  await checkAsync('reaproveita túnel existente e adiciona rota', async () => {
    const fakes = makeFakes();
    fakes.state.tunnelId = '99999999-8888-7777-6666-555555555555';
    fs.writeFileSync(path.join(tempHome, 'creds.json'), '{"TunnelID":"x"}', { mode: 0o600 });
    fakes.state.configContent = configTools.buildConfigText({
      tunnelId: fakes.state.tunnelId,
      credentialsFile: path.join(tempHome, 'creds.json'),
      routes: [{ hostname: 'ja-existe.exemplo.com', port: 4000 }],
    });

    const publisher = new Publisher({
      api: fakes.api, cloudflare: fakes.cloudflare, services: fakes.services, checker: fakes.checker,
    });

    const result = await publisher.publishSubdomain({
      subdomain: 'novo',
      domain: 'exemplo.com',
      port: 5001,
      tunnelMode: 'existing',
      existingTunnel: 'meu-tunel',
      createDns: true,
      startService: true,
    });

    assert.ok(result.ok, JSON.stringify(result.steps));
    const routes = configTools.listRoutes(fakes.state.configContent);
    assert.strictEqual(routes.length, 2, 'deveria ter 2 rotas');
    assert.ok(routes.some((r) => r.hostname === 'novo.exemplo.com'), 'rota nova ausente');
    assert.ok(routes.some((r) => r.hostname === 'ja-existe.exemplo.com'), 'rota antiga foi perdida');
    assert.ok(!fakes.calls.some((c) => c.startsWith('createTunnel')), 'não deveria criar túnel novo');
    return `${routes.length} rotas no mesmo túnel`;
  });

  await checkAsync('DNS já existente não é recriado', async () => {
    const fakes = makeFakes();
    fakes.state.tunnelId = '11111111-2222-3333-4444-555555555555';
    fs.writeFileSync(path.join(tempHome, 'c.json'), '{"TunnelID":"x"}', { mode: 0o600 });
    fakes.state.configContent = configTools.buildConfigText({
      tunnelId: fakes.state.tunnelId,
      credentialsFile: path.join(tempHome, 'c.json'),
      routes: [],
    });
    fs.writeFileSync(path.join(tempHome, 'meu-tunel.yml'), fakes.state.configContent, { mode: 0o600 });
    fakes.state.dns.push({
      type: 'CNAME',
      name: 'api.exemplo.com',
      content: '11111111-2222-3333-4444-555555555555.cfargotunnel.com',
    });

    const publisher = new Publisher({
      api: fakes.api, cloudflare: fakes.cloudflare, services: fakes.services, checker: fakes.checker,
    });
    const result = await publisher.publishSubdomain({
      subdomain: 'api', domain: 'exemplo.com', port: 3000, tunnelMode: 'existing', existingTunnel: 'meu-tunel',
    });

    const dnsStep = stepOf(result, 'dns');
    assert.strictEqual(dnsStep.state, 'ok');
    assert.ok(/já existia/i.test(dnsStep.detail), dnsStep.detail);
    assert.ok(!fakes.calls.some((c) => c.startsWith('routeDNS')), 'não deveria chamar routeDNS');
    return dnsStep.detail;
  });

  console.log('\n== publicar: bloqueios ==');
  await checkAsync('recusa domínio não autorizado antes de criar nada', async () => {
    const fakes = makeFakes({ authorized: false });
    const publisher = new Publisher({
      api: fakes.api, cloudflare: fakes.cloudflare, services: fakes.services, checker: fakes.checker,
    });
    const result = await publisher.publishSubdomain({
      subdomain: 'api', domain: 'outro-dominio.com', port: 3000, tunnelMode: 'new',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(stepOf(result, 'zone').state, 'error');
    assert.ok(!fakes.calls.some((c) => c.startsWith('createTunnel')), 'criou túnel mesmo sem autorização');
    assert.ok(/Autenticar/.test(stepOf(result, 'zone').detail), 'mensagem deveria orientar o login');
    return 'bloqueado no passo zone';
  });

  await checkAsync('recusa hostname inválido', async () => {
    const fakes = makeFakes();
    const publisher = new Publisher({
      api: fakes.api, cloudflare: fakes.cloudflare, services: fakes.services, checker: fakes.checker,
    });
    const result = await publisher.publishSubdomain({ subdomain: 'sem-tld', domain: '', port: 3000 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(stepOf(result, 'input').state, 'error');
    return stepOf(result, 'input').detail;
  });

  await checkAsync('recusa porta inválida', async () => {
    const fakes = makeFakes();
    const publisher = new Publisher({
      api: fakes.api, cloudflare: fakes.cloudflare, services: fakes.services, checker: fakes.checker,
    });
    const result = await publisher.publishSubdomain({ subdomain: 'api.exemplo.com', port: '70000' });
    assert.strictEqual(result.ok, false);
    assert.ok(/Porta inválida/.test(stepOf(result, 'input').detail));
    return 'bloqueado no passo input';
  });

  await checkAsync('avisa quando não há serviço local, mas continua', async () => {
    const fakes = makeFakes({ localListening: false });
    const publisher = new Publisher({
      api: fakes.api, cloudflare: fakes.cloudflare, services: fakes.services, checker: fakes.checker,
    });
    const result = await publisher.publishSubdomain({
      subdomain: 'api', domain: 'exemplo.com', port: 3000, tunnelMode: 'new',
    });
    assert.strictEqual(stepOf(result, 'local').state, 'warn');
    assert.ok(result.warnings.some((w) => /502/.test(w)), JSON.stringify(result.warnings));
    assert.ok(result.ok, 'deveria continuar mesmo com aviso');
    return result.warnings[0].slice(0, 60);
  });

  fs.rmSync(tempHome, { recursive: true, force: true });

  console.log(`\n== resultado: ${passed} ok, ${failed} falhas ==\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('erro inesperado:', error);
  fs.rmSync(tempHome, { recursive: true, force: true });
  process.exit(1);
});
