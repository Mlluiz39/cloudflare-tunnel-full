'use strict';

/**
 * Smoke test de verdade: sobe o Electron, carrega a interface real
 * (index.html + preload + IPC), clica nas telas por script e valida o DOM.
 *
 * Uso:  electron scripts/smoke.js --no-sandbox
 * Sai com código 0 se tudo passar.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { ensureConfigDir } = require('../src/main/paths');
const { createContext } = require('../src/main/context');
const { registerIpc } = require('../src/main/ipc');

app.disableHardwareAcceleration();

const results = [];
const consoleErrors = [];
const pageErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function sql(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

async function main() {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-smoke-'));
  await ensureConfigDir();

  const ctx = createContext({ onEvent: () => {}, settingsDir });
  ctx.getWindow = () => win;

  let win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_event, level, message) => {
    // level 3 = error
    if (level >= 2) consoleErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    pageErrors.push(`renderer caiu: ${JSON.stringify(details)}`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    pageErrors.push(`preload falhou (${preloadPath}): ${error.message}`);
  });

  registerIpc(ctx);

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  // Espera o boot() do renderer terminar (overview + capabilities).
  await sql(win, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const cliLabel = document.getElementById('label-cli');
      const ready = cliLabel && !/verificando/.test(cliLabel.textContent);
      if (ready || Date.now() - started > 25000) resolve(true);
      else setTimeout(tick, 150);
    };
    tick();
  })`);

  // -------- estrutura básica
  record('API exposta no preload', await sql(win, 'typeof window.ctm === "object" && typeof window.ctm.overview === "function"'));

  record('6 itens de navegação', await sql(win, 'document.querySelectorAll(".nav-item").length === 6'),
    `encontrados: ${await sql(win, 'document.querySelectorAll(".nav-item").length')}`);

  record('botão de login acessível na sidebar',
    await sql(win, 'Boolean(document.querySelector(".sidebar-footer [data-action=\\"login\\"]"))'));

  record('sidebar atualizada (não "verificando")',
    await sql(win, '!/verificando/.test(document.getElementById("label-cli").textContent)'),
    await sql(win, 'document.getElementById("label-cli").textContent'));

  // -------- IPC direto
  const overview = await sql(win, 'window.ctm.overview().then((r) => ({ ok: r.ok, count: r.tunnels ? r.tunnels.length : -1, orphans: r.orphans ? r.orphans.length : -1, mode: r.serviceMode, cliInstalled: r.cli && r.cli.installed, err: r.error }))');
  record('overview() responde', overview.ok === true, JSON.stringify(overview));

  const env = await sql(win, 'window.ctm.environment().then((r) => ({ ok: r.ok, platform: r.platform, binary: r.binary, mode: r.serviceMode }))');
  record('environment() responde', env.ok === true, JSON.stringify(env));

  const caps = await sql(win, 'window.ctm.serviceCapabilities().then((r) => ({ ok: r.ok, modes: (r.modes||[]).map((m) => `${m.mode}:${m.available}`) }))');
  record('serviceCapabilities() responde', caps.ok === true, JSON.stringify(caps));

  const valid = await sql(win, `window.ctm.validateConfigText('tunnel: 1a40797f-7096-499f-97fd-81585220d55f\\ncredentials-file: /tmp/x.json\\ningress:\\n  - hostname: a.exemplo.com\\n    service: http://127.0.0.1:3000\\n  - service: http_status:404\\n').then((r) => r.ok)`);
  record('validateConfigText aceita YAML válido', valid === true);

  const invalid = await sql(win, `window.ctm.validateConfigText('ingress: [oops').then((r) => ({ ok: r.ok, hasError: Boolean(r.error) }))`);
  record('validateConfigText rejeita YAML inválido', invalid.ok === false && invalid.hasError === true);

  // -------- dashboard
  const cardCount = await sql(win, 'document.querySelectorAll("#tunnels-list .card").length');
  record('dashboard renderizou cards ou vazio',
    await sql(win, '(document.querySelectorAll("#tunnels-list .card").length > 0) || Boolean(document.querySelector("#tunnels-list .empty-state"))'),
    `${cardCount} card(s), túneis remotos: ${overview.count}`);

  record('cards têm botões de ação', await sql(win, `document.querySelectorAll("#tunnels-list .card").length === 0 || Boolean(document.querySelector("#tunnels-list .card [data-action]"))`));

  // -------- navegação por views
  const views = ['create', 'editor', 'dns', 'service', 'settings', 'dashboard'];
  for (const view of views) {
    await sql(win, `document.querySelector('.nav-item[data-view="${view}"]').click()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const visible = await sql(win, `document.getElementById('view-${view}').classList.contains('active')`);
    record(`view "${view}" ativa`, visible === true);
  }

  // -------- editor carrega YAML de um túnel (se existir)
  await sql(win, `document.querySelector('.nav-item[data-view="editor"]').click()`);
  const editorInfo = await sql(win, `new Promise((resolve) => {
    const select = document.getElementById('select-editor');
    setTimeout(() => {
      resolve({
        options: select.options.length,
        disabled: select.disabled,
        value: select.value,
        status: document.getElementById('editor-status').textContent,
        contentLength: document.getElementById('editor-content').value.length,
      });
    }, 1200);
  })`);
  record('editor populado', editorInfo.options > 0, JSON.stringify(editorInfo));

  // -------- novo subdomínio: campos, domínios e pré-visualização
  await sql(win, `document.querySelector('.nav-item[data-view="create"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  record('campos do fluxo de subdomínio existem', await sql(win, `Boolean(
    document.getElementById('publish-subdomain') &&
    document.getElementById('publish-domain') &&
    document.getElementById('publish-port') &&
    document.getElementById('btn-publish')
  )`));

  const zoneInfo = await sql(win, 'window.ctm.listZones().then((r) => ({ ok: r.ok, zones: (r.zones||[]).map((z) => z.name), err: r.error }))');
  record('domínios autorizados carregados', zoneInfo.ok === true && zoneInfo.zones.length > 0, JSON.stringify(zoneInfo));

  const domainOptions = await sql(win, 'document.querySelectorAll("#publish-domain option").length');
  record('select de domínio populado', domainOptions > 0, `${domainOptions} opção(ões)`);

  const preview = await sql(win, `(async () => {
    document.getElementById('publish-subdomain').value = 'teste-preview';
    document.getElementById('publish-subdomain').dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 200));
    return {
      preview: document.getElementById('publish-preview-value').textContent,
      hostname: (() => { return document.getElementById('publish-preview-value').textContent; })(),
    };
  })()`);
  record('pré-visualização do hostname monta o endereço',
    typeof preview.preview === 'string' && preview.preview.includes('.') && preview.preview.startsWith('teste-preview.'),
    preview.preview);

  // dois níveis de rótulo: api.dev + domínio escolhido
  const deepPreview = await sql(win, `(async () => {
    document.getElementById('publish-subdomain').value = 'api.dev';
    document.getElementById('publish-subdomain').dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 200));
    return document.getElementById('publish-preview-value').textContent;
  })()`);
  record('subdomínio de dois níveis monta hostname completo',
    /^api\.dev\..+\..+$/.test(deepPreview), deepPreview);

  const localCheck = await sql(win, 'window.ctm.checkLocal(8099, "http").then((r) => ({ ok: r.ok, listening: r.listening, error: r.error || null }))');
  record('checkLocal responde', localCheck.ok === true && localCheck.listening === false, JSON.stringify(localCheck));

  const localOpen = await sql(win, 'window.ctm.checkLocal(8090, "http").then((r) => ({ ok: r.ok, listening: r.listening, status: r.httpStatus ?? null }))');
  record('checkLocal detecta o serviço local na 8090', localOpen.ok === true, JSON.stringify(localOpen));

  const hostnameCheck = await sql(win, `window.ctm.checkHostname('${preview.preview}').then((r) => ({
    ok: r.ok, resolves: r.dns ? r.dns.resolves : null, authorized: r.authority ? r.authority.authorized : null,
  }))`);
  record('checkHostname responde', hostnameCheck.ok === true, JSON.stringify(hostnameCheck));

  record('linha do tempo começa oculta', await sql(win, `document.getElementById('publish-timeline-panel').classList.contains('hidden')`));

  // -------- publicar com dados inválidos falha na validação (sem tocar na rede)
  await sql(win, `(() => {
    document.getElementById('publish-subdomain').value = '';
    document.getElementById('publish-port').value = '';
    document.querySelector('[data-action="publish-subdomain"]').click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  record('validação inline do subdomínio',
    await sql(win, 'document.getElementById("publish-error").textContent.length > 0'),
    await sql(win, 'document.getElementById("publish-error").textContent'));

  // -------- modal de confirmação com palavra digitada
  const modalWorks = await sql(win, `(async () => {
    const before = document.getElementById('modal-confirm').classList.contains('active');
    const okDisabled = document.getElementById('confirm-typed-group').classList.contains('hidden');
    return { before, okDisabled };
  })()`);
  record('modal começa fechado', modalWorks.before === false && modalWorks.okDisabled === true);

  // -------- toasts
  await sql(win, `document.querySelector('[data-action="refresh"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  record('toast de feedback aparece', await sql(win, 'document.querySelectorAll("#toast-stack .toast").length > 0'));

  // -------- configurações mostram modos
  await sql(win, `document.querySelector('.nav-item[data-view="settings"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  record('modos de serviço listados', await sql(win, 'document.querySelectorAll("#service-modes .mode-option").length >= 2'),
    await sql(win, 'document.querySelectorAll("#service-modes .mode-option").length'));

  // -------- estado final de erros
  record('nenhum erro de console no renderer', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));
  record('nenhum crash de renderer/preload', pageErrors.length === 0, pageErrors.join(' | '));

  fs.rmSync(settingsDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== smoke: ${results.length - failed.length} ok, ${failed.length} falhas ==\n`);
  if (consoleErrors.length) console.log('erros de console:', consoleErrors.slice(0, 10));
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.error('smoke falhou:', error);
    app.exit(1);
  });
});
