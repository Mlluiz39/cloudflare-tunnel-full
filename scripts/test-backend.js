'use strict';

/**
 * Testes de back-end sem Electron.
 * Rode com: node scripts/test-backend.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-test-'));
process.env.CLOUDFLARED_HOME = testDir;

const paths = require('../src/main/paths');
const configTools = require('../src/main/config');
const { CloudflaredAPI } = require('../src/main/cloudflared');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

async function main() {
  console.log('\n== validações ==');
  check('nome válido', () => assert.ok(paths.isValidName('meu-tunel_1')));
  check('nome rejeita espaço', () => assert.ok(!paths.isValidName('meu tunel')));
  check('nome rejeita começar com -', () => assert.ok(!paths.isValidName('-x')));
  check('hostname válido', () => assert.ok(paths.isValidHostname('api.exemplo.com')));
  check('hostname rejeita sem TLD', () => assert.ok(!paths.isValidHostname('api')));
  check('hostname rejeita ..', () => assert.ok(!paths.isValidHostname('a..b.com')));
  check('porta válida', () => assert.ok(paths.isValidPort(3000)));
  check('porta rejeita 0', () => assert.ok(!paths.isValidPort(0)));
  check('porta rejeita 70000', () => assert.ok(!paths.isValidPort(70000)));
  check('porta rejeita texto', () => assert.ok(!paths.isValidPort('abc')));

  console.log('\n== geração de YAML ==');
  const built = configTools.buildConfigText({
    tunnelId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    credentialsFile: '/tmp/creds.json',
    routes: [
      { hostname: 'api.exemplo.com', scheme: 'http', port: 3000 },
      { hostname: 'app.exemplo.com', path: '/x', scheme: 'https', port: 8443 },
    ],
  });
  console.log(built.replace(/^/gm, '       | '));
  check('contém tunnel', () => assert.ok(built.includes('tunnel: aaaaaaaa')));
  check('contém credenciais', () => assert.ok(built.includes('credentials-file: /tmp/creds.json')));
  check('catch-all 404 no fim', () => assert.ok(/http_status:404\s*$/.test(built)));
  check('validação estrutural passa', () => assert.ok(configTools.validateConfigText(built).ok));

  const parsed = configTools.parseConfig(built);
  check('parse devolve 3 regras', () => assert.strictEqual(parsed.ingress.length, 3));
  check('parse devolve hostname', () => assert.strictEqual(parsed.ingress[0].hostname, 'api.exemplo.com'));
  check('parse devolve service', () => assert.strictEqual(parsed.ingress[0].service, 'http://127.0.0.1:3000'));
  check('parse devolve path', () => assert.strictEqual(parsed.ingress[1].path, '/x'));

  console.log('\n== inserir/remover rota preservando comentários ==');
  const withComment = `# meu comentário\n${built}`;
  const inserted = configTools.insertRoute(withComment, { hostname: 'novo.exemplo.com', scheme: 'http', port: 9000 });
  check('comentário preservado', () => assert.ok(inserted.includes('# meu comentário')));
  check('nova rota inserida', () => assert.ok(inserted.includes('novo.exemplo.com')));
  check('catch-all continua por último', () => assert.ok(/http_status:404\s*$/.test(inserted)));
  const insertedParsed = configTools.parseConfig(inserted);
  check('regras após inserir = 4', () => assert.strictEqual(insertedParsed.ingress.length, 4));
  check('ordem preservada', () => assert.strictEqual(insertedParsed.ingress[2].hostname, 'novo.exemplo.com'));

  const removed = configTools.removeRoute(inserted, { hostname: 'novo.exemplo.com' });
  check('remoção ok', () => assert.ok(removed.ok));
  check('rota removida', () => assert.ok(!removed.text.includes('novo.exemplo.com')));
  check('catch-all preservado', () => assert.ok(/http_status:404/.test(removed.text)));
  check('comentário preservado após remover', () => assert.ok(removed.text.includes('# meu comentário')));

  console.log('\n== validação pega erros comuns ==');
  check('rejeita sem ingress', () => {
    const res = configTools.validateConfigText('tunnel: x\ncredentials-file: y\n');
    assert.ok(!res.ok);
  });
  check('rejeita YAML quebrado', () => {
    const res = configTools.validateConfigText('ingress: [oops');
    assert.ok(!res.ok);
  });
  check('rejeita última regra não catch-all', () => {
    const res = configTools.validateConfigText(
      'tunnel: x\ncredentials-file: y\ningress:\n  - hostname: a.com\n    service: http://127.0.0.1:1\n',
    );
    assert.ok(!res.ok);
  });
  check('rejeita catch-all no meio da lista', () => {
    const res = configTools.validateConfigText(
      'tunnel: x\ncredentials-file: y\ningress:\n  - service: http://127.0.0.1:1\n  - service: http_status:404\n',
    );
    assert.ok(!res.ok);
  });
  check('catch-all customizado vira a última regra', () => {
    const text = configTools.buildConfigText({
      tunnelId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      credentialsFile: '/tmp/c.json',
      routes: [{ hostname: 'a.com', port: 80 }, { scheme: 'http', port: 8080 }],
    });
    assert.ok(/http_status:404/.test(text) === false, 'não deve duplicar o 404');
    const rules = configTools.parseConfig(text).ingress;
    assert.strictEqual(rules.length, 2);
    assert.strictEqual(rules[1].service, 'http://127.0.0.1:8080');
    assert.ok(configTools.validateConfigText(text).ok);
  });

  console.log('\n== cloudflared real ==');
  const api = new CloudflaredAPI();
  const status = await api.status();
  console.log(`       binário: ${status.binary}`);
  console.log(`       versão : ${status.version}`);
  console.log(`       autent.: ${status.authenticated}`);
  check('detecta instalação', () => assert.ok(status.installed));

  const list = await api.listTunnels();
  check('lista túneis remotos', () => assert.ok(list.ok && Array.isArray(list.tunnels)));
  console.log(`       túneis  : ${list.tunnels.map((t) => t.name).join(', ') || '(nenhum)'}`);

  await checkAsync('validateText aceita config válida', async () => {
    const res = await api.validateText(built);
    assert.ok(res.ok, res.error);
  });

  await checkAsync('validateText rejeita service sem esquema', async () => {
    const bad = built.replace('http://127.0.0.1:3000', '127.0.0.1:3000');
    const res = await api.validateText(bad);
    assert.ok(!res.ok);
  });

  await checkAsync('saveConfig grava arquivo novo', async () => {
    const res = await api.saveConfig('teste-gui', built, { skipBackup: true });
    assert.ok(res.ok, res.error);
    assert.ok(fs.existsSync(path.join(testDir, 'teste-gui.yml')));
  });

  await checkAsync('saveConfig NÃO grava config inválida (rollback)', async () => {
    const before = fs.readFileSync(path.join(testDir, 'teste-gui.yml'), 'utf8');
    const res = await api.saveConfig('teste-gui', 'ingress: [quebrado');
    assert.ok(!res.ok, 'deveria falhar');
    const after = fs.readFileSync(path.join(testDir, 'teste-gui.yml'), 'utf8');
    assert.strictEqual(after, before, 'arquivo original deve permanecer intacto');
  });

  await checkAsync('saveConfig cria backup ao sobrescrever', async () => {
    const changed = built.replace('http_status:404', 'http_status:404');
    const res = await api.saveConfig('teste-gui', changed);
    assert.ok(res.ok, res.error);
    assert.ok(res.backupPath && fs.existsSync(res.backupPath), 'backup deveria existir');
    const backups = await api.listBackups('teste-gui');
    assert.ok(backups.length >= 1);
  });

  await checkAsync('readConfig devolve rotas', async () => {
    const res = await api.readConfig('teste-gui');
    assert.ok(res.ok, res.error);
    assert.ok(res.routes.length >= 2, `rotas: ${JSON.stringify(res.routes)}`);
  });

  await checkAsync('createTunnel rejeita nome inválido', async () => {
    // nunca toca na rede: nome é validado antes de qualquer chamada
    const res = await api.createTunnel({ name: 'nome invalido' });
    assert.ok(!res.ok);
    assert.ok(/Nome inválido/.test(res.error));
  });

  await checkAsync('createTunnel rejeita config existente (sem criar nada)', async () => {
    const res = await api.createTunnel({ name: 'teste-gui' });
    assert.ok(!res.ok);
    assert.ok(/Já existe a configuração/.test(res.error), res.error);
  });

  await checkAsync('scaffoldConfig cria YAML e protege contra sobrescrita', async () => {
    const first = await api.scaffoldConfig({
      name: 'teste-scaffold',
      tunnelId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    assert.ok(first.ok, first.error);
    const second = await api.scaffoldConfig({
      name: 'teste-scaffold',
      tunnelId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    assert.ok(!second.ok && second.exists === true, 'deveria recusar sobrescrever');
    const forced = await api.scaffoldConfig({
      name: 'teste-scaffold',
      tunnelId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      overwrite: true,
    });
    assert.ok(forced.ok, forced.error);
    assert.ok(Boolean(forced.ok), 'sobrescrita confirmada deveria funcionar');
  });

  await checkAsync('deleteTunnel remove YAML, credenciais e backups', async () => {
    const name = 'teste-delete';
    const id = 'deadbeef-1111-2222-3333-444444444444';
    const cfg = path.join(testDir, `${name}.yml`);
    const creds = path.join(testDir, `${id}.json`);
    const backup = path.join(testDir, `${name}.yml.20260101-000000.bak`);
    fs.writeFileSync(cfg, 'tunnel: x\n', { mode: 0o600 });
    fs.writeFileSync(creds, '{}', { mode: 0o600 });
    fs.writeFileSync(backup, 'antigo\n', { mode: 0o600 });

    // Dublê do CLI: aceita cleanup/delete sem tocar na conta Cloudflare.
    const originalExec = api.exec;
    const commands = [];
    api.exec = async (args) => {
      commands.push(args.join(' '));
      return { ok: true, stdout: '', stderr: '' };
    };

    try {
      const res = await api.deleteTunnel({ id, name, removeFiles: true });
      assert.ok(res.ok, res.error);
      assert.ok(!fs.existsSync(cfg), 'YAML ficou para trás');
      assert.ok(!fs.existsSync(creds), 'credenciais ficaram para trás');
      assert.ok(!fs.existsSync(backup), 'backup ficou para trás');
      assert.ok(commands.some((c) => c.startsWith('tunnel cleanup')), 'não chamou cleanup');
      assert.ok(commands.some((c) => c.startsWith('tunnel delete')), 'não chamou delete');
      return `${res.removed.length} arquivo(s) removido(s)`;
    } finally {
      api.exec = originalExec;
    }
  });

  await checkAsync('routeDNS valida hostname', async () => {
    const res = await api.routeDNS({ tunnel: 'teste-gui', hostname: 'sem-tld' });
    assert.ok(!res.ok);
  });

  await checkAsync('backup gera tar.gz legível', async () => {
    const res = await api.createBackup();
    assert.ok(res.ok, res.error);
    assert.ok(fs.existsSync(res.path));
    const size = fs.statSync(res.path).size;
    assert.ok(size > 0);
    console.log(`       backup  : ${res.path} (${size} bytes)`);
    fs.rmSync(res.path, { force: true });
  });

  fs.rmSync(testDir, { recursive: true, force: true });

  console.log(`\n== resultado: ${passed} ok, ${failed} falhas ==\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('erro inesperado:', error);
  process.exit(1);
});
