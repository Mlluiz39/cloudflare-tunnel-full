'use strict';

/**
 * Testa o ciclo de vida do serviço de verdade (systemd --user) usando um
 * túnel descartável: cria a unidade, ativa, consulta status, lê logs, para,
 * desativa e remove tudo no final.
 *
 * Não toca em nenhum túnel real da Cloudflare — o YAML aponta para um UUID
 * fictício, então o cloudflared apenas falha ao conectar (esperado).
 *
 * Uso: node scripts/test-services.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_TUNNEL = 'ctm-selftest';
const TEST_UUID = '00000000-1111-2222-3333-444444444444';

const paths = require('../src/main/paths');
const configTools = require('../src/main/config');
const { Settings } = require('../src/main/settings');
const { Privilege } = require('../src/main/privilege');
const { CloudflaredAPI } = require('../src/main/cloudflared');
const { ServiceManager, systemdUnitContent } = require('../src/main/services');

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

async function main() {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-svc-'));
  const settings = new Settings(settingsDir);
  settings.set({ serviceMode: 'user' });

  const privilege = new Privilege();
  const api = new CloudflaredAPI({ privilege });
  const services = new ServiceManager({ privilege, settings, cloudflaredAPI: api });

  console.log('\n== capacidades ==');
  const caps = await services.capabilities();
  console.log('       ', JSON.stringify(caps));

  await checkAsync('modo usuário disponível', async () => {
    const mode = caps.modes.find((m) => m.mode === 'user');
    assert(mode && mode.available, mode && mode.reason);
    return 'systemctl --user ok';
  });

  await checkAsync('modo sistema reporta capacidade', async () => {
    const mode = caps.modes.find((m) => m.mode === 'system');
    assert(mode, 'modo system ausente');
    return `disponível=${mode.available} (método: ${caps.privilege.method})`;
  });

  await checkAsync('conteúdo da unidade de sistema (template) está correto', async () => {
    const text = systemdUnitContent({
      description: 'Cloudflare Tunnel Manager - %i',
      execStart: '"/usr/bin/cloudflared" --config "/home/u/.cloudflared/%i.yml" tunnel run',
      workingUser: 'u',
      home: '/home/u',
      hardening: 'system',
    });
    assert(text.includes('User=u'), 'sem User=');
    assert(text.includes('Environment=HOME=/home/u'), 'sem HOME');
    assert(text.includes('WantedBy=multi-user.target'), 'sem WantedBy');
    assert(text.includes('%i.yml'), 'sem %i');
    return 'ok';
  });

  // ---------- prepara um túnel descartável
  fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
  const configPath = path.join(paths.CONFIG_DIR, `${TEST_TUNNEL}.yml`);
  const credsPath = path.join(paths.CONFIG_DIR, `${TEST_UUID}.json`);
  fs.writeFileSync(credsPath, '{"AccountTag":"x","TunnelSecret":"y","TunnelID":"z"}', { mode: 0o600 });
  fs.writeFileSync(configPath, configTools.buildConfigText({
    tunnelId: TEST_UUID,
    credentialsFile: credsPath,
    routes: [{ hostname: 'selftest.exemplo.com', port: 6553 }],
  }), { mode: 0o600 });

  console.log('\n== status inicial ==');
  await checkAsync('túnel de teste aparece como não instalado', async () => {
    const status = await services.status(TEST_TUNNEL);
    assert(status.installed === false, JSON.stringify(status));
    return status.state;
  });

  console.log('\n== ciclo de vida (systemd --user) ==');
  await checkAsync('startOrInstall() cria unidade e inicia SEM ligar autostart', async () => {
    const res = await services.startOrInstall(TEST_TUNNEL);
    assert(res.ok, res.error);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const status = await services.status(TEST_TUNNEL);
    assert(status.installed === true, 'unidade não foi criada');
    assert(status.enabled === false, `autostart não deveria ligar sozinho (enabled=${status.enabled})`);
    return `enabled=${status.enabled} state=${status.state}`;
  });

  await checkAsync('enable() cria a unidade e ativa', async () => {
    const res = await services.enable(TEST_TUNNEL);
    assert(res.ok, res.error);
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `cloudflared-${TEST_TUNNEL}.service`);
    assert(fs.existsSync(unitPath), `unidade não criada: ${unitPath}`);
    const content = fs.readFileSync(unitPath, 'utf8');
    assert(content.includes('--no-autoupdate'), 'faltou --no-autoupdate');
    assert(content.includes(configPath), 'ExecStart sem o caminho do YAML');
    return unitPath;
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));

  await checkAsync('status() enxerga a unidade ativa (ou falhando)', async () => {
    const status = await services.status(TEST_TUNNEL);
    assert(status.installed === true, 'installed=false');
    return `state=${status.state} enabled=${status.enabled} mode=${status.mode}`;
  });

  await checkAsync('autostart (enable) marcado', async () => {
    const status = await services.status(TEST_TUNNEL);
    assert(status.enabled === true, `enabled=${status.enabled}`);
    return 'enabled=true';
  });

  await checkAsync('logs() devolve saída do journal', async () => {
    const res = await services.logs(TEST_TUNNEL, { lines: 20 });
    assert(typeof res.logs === 'string' && res.logs.length > 0, 'sem logs');
    return res.logs.split('\n').slice(0, 2).join(' / ').slice(0, 160);
  });

  await checkAsync('stop() para o serviço', async () => {
    const res = await services.stop(TEST_TUNNEL);
    assert(res.ok, res.error);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const status = await services.status(TEST_TUNNEL);
    assert(status.running === false, 'ainda rodando');
    return `state=${status.state}`;
  });

  await checkAsync('start() inicia de novo', async () => {
    const res = await services.start(TEST_TUNNEL);
    assert(res.ok, res.error);
    return 'start ok';
  });

  await checkAsync('restart() reinicia', async () => {
    const res = await services.restart(TEST_TUNNEL);
    assert(res.ok, res.error);
    return 'restart ok';
  });

  await checkAsync('disable() desativa o autostart mantendo a unidade', async () => {
    const res = await services.disable(TEST_TUNNEL);
    assert(res.ok, res.error);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await services.status(TEST_TUNNEL);
    assert(status.enabled === false, `enabled=${status.enabled}`);
    assert(status.installed === true, 'a unidade não deveria ser apagada por disable()');
    return 'enabled=false, unidade preservada';
  });

  await checkAsync('enable() recusa criar unidade duplicada no outro modo', async () => {
    settings.set({ serviceMode: 'system' });
    const res = await services.enable(TEST_TUNNEL);
    assert(res.ok === false && res.conflict === true, `esperava conflito, veio: ${JSON.stringify(res)}`);
    settings.set({ serviceMode: 'user' });
    return 'conflito detectado (sem tocar em /etc)';
  });

  await checkAsync('logCommand() monta o comando de acompanhamento', async () => {
    const resolved = await services.resolve(TEST_TUNNEL);
    const cmd = resolved.impl.logCommand(TEST_TUNNEL, { lines: 50, follow: true });
    assert(cmd.cmd === 'journalctl', cmd.cmd);
    assert(cmd.args.includes('-f'), 'sem -f');
    return `${cmd.cmd} ${cmd.args.join(' ')}`;
  });

  await checkAsync('listManaged() lista o túnel de teste', async () => {
    const list = await services.listManaged();
    assert(list.includes(TEST_TUNNEL), list.join(','));
    return list.join(', ');
  });

  console.log('\n== limpeza ==');
  await checkAsync('removeUnit() apaga a unidade', async () => {
    const res = await services.removeUnit(TEST_TUNNEL);
    assert(res.ok, res.error);
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `cloudflared-${TEST_TUNNEL}.service`);
    assert(!fs.existsSync(unitPath), 'unidade continua no disco');
    return 'unidade removida';
  });

  await checkAsync('status() volta a "ausente"', async () => {
    const status = await services.status(TEST_TUNNEL);
    assert(status.installed === false, JSON.stringify(status));
    return status.state;
  });

  await checkAsync('arquivos temporários removidos', async () => {
    fs.rmSync(configPath, { force: true });
    fs.rmSync(credsPath, { force: true });
    assert(!fs.existsSync(configPath), 'yml ficou para trás');
    return 'yml + credenciais de teste apagados';
  });

  fs.rmSync(settingsDir, { recursive: true, force: true });

  console.log(`\n== resultado: ${passed} ok, ${failed} falhas ==\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('erro inesperado:', error);
  // limpeza de emergência
  try {
    fs.rmSync(path.join(paths.CONFIG_DIR, `${TEST_TUNNEL}.yml`), { force: true });
    fs.rmSync(path.join(paths.CONFIG_DIR, `${TEST_UUID}.json`), { force: true });
  } catch { /* ignora */ }
  process.exit(1);
});
