'use strict';

const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const { CONFIG_DIR, configPathFor, isValidHostname } = require('./paths');
const configTools = require('./config');
const checkup = require('./checkup');
const { preflight: runPreflight } = require('./preflight');

/**
 * Registra todos os canais IPC. Toda função devolve um objeto
 * `{ ok: boolean, error?: string, ... }` — nada lança para o renderer.
 */
function registerIpc(ctx) {
  const {
    api, cloudflare, services, platform, runner, publisher, settings, getWindow,
  } = ctx;

  const win = () => getWindow();
  const wrap = (fn) => async (event, payload) => {
    try {
      return await fn(payload, event);
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  };

  /** Antes de subir um serviço: config existe, valida e credenciais presentes. */
  const preflight = (name) => runPreflight(api, name);

  // ------------------------------------------------- domínios / checagens
  ipcMain.handle('zones:list', wrap(async () => {
    const result = await cloudflare.zones();
    return {
      ok: result.ok,
      zones: result.zones,
      error: result.error,
      cert: cloudflare.certInfo(),
    };
  }));

  ipcMain.handle('check:local', wrap(async (payload = {}) => ({
    ok: true,
    ...(await checkup.checkLocalService({
      port: payload.port,
      scheme: payload.scheme || 'http',
    })),
  })));

  ipcMain.handle('check:hostname', wrap(async (payload = {}) => {
    const hostname = String(payload.hostname || '').trim();
    if (!hostname) return { ok: false, error: 'Hostname vazio.' };
    const dns = await checkup.checkHostname(hostname);
    const authority = await cloudflare.checkHostnameAuthority(hostname);
    const records = authority.authorized ? await cloudflare.dnsRecordsFor(hostname) : { records: [] };
    return {
      ok: true,
      hostname,
      dns,
      authority: {
        known: authority.known,
        authorized: authority.authorized,
        zone: authority.zone,
        zones: authority.zones,
      },
      records: records.records || [],
    };
  }));

  // --------------------------------------------- criar subdomínio (visual)
  ipcMain.handle('publish:subdomain', wrap(async (payload = {}) => {
    const result = await publisher.publishSubdomain(payload);
    return { ok: result.ok !== false, ...result };
  }));

  // ------------------------------------------------------------- ambiente
  ipcMain.handle('app:environment', wrap(async () => ({ ok: true, ...platform.environment() })));
  ipcMain.handle('app:overview', wrap(async () => ({ ok: true, ...(await platform.overview()) })));
  ipcMain.handle('app:settings:get', wrap(async () => ({ ok: true, settings: settings.all() })));
  ipcMain.handle('app:settings:set', wrap(async (patch) => ({ ok: true, settings: settings.set(patch || {}) })));
  ipcMain.handle('app:openConfigDir', wrap(async () => {
    const error = await shell.openPath(CONFIG_DIR);
    return error ? { ok: false, error } : { ok: true };
  }));
  ipcMain.handle('app:openPath', wrap(async (target) => {
    if (!target) return { ok: false, error: 'Caminho vazio.' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  }));
  ipcMain.handle('app:openExternal', wrap(async (url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'URL inválida.' };
    await shell.openExternal(url);
    return { ok: true };
  }));

  /** Remove um .yml órfão, mas só dentro de ~/.cloudflared. */
  ipcMain.handle('app:removeOrphanConfig', wrap(async (target) => {
    const resolved = path.resolve(String(target || ''));
    const configDir = path.resolve(CONFIG_DIR);
    if (path.dirname(resolved) !== configDir) {
      return { ok: false, error: 'Só é permitido remover arquivos dentro de ~/.cloudflared.' };
    }
    if (!resolved.endsWith('.yml')) {
      return { ok: false, error: 'Apenas arquivos .yml podem ser removidos por aqui.' };
    }
    await fsp.rm(resolved, { force: true });
    return { ok: true, removed: resolved };
  }));
  ipcMain.handle('app:saveDialog', wrap(async (options = {}) => {
    const result = await dialog.showSaveDialog(win(), {
      title: options.title || 'Salvar',
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    return { ok: !result.canceled && Boolean(result.filePath), filePath: result.filePath, canceled: result.canceled };
  }));
  ipcMain.handle('app:appInfo', wrap(async () => ({
    ok: true,
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
  })));

  // ------------------------------------------------------------------ CLI
  ipcMain.handle('cli:status', wrap(async () => ({ ok: true, ...(await api.status()) })));
  ipcMain.handle('cli:install', wrap(async () => api.install()));
  ipcMain.handle('cli:uninstall', wrap(async () => api.uninstall()));
  ipcMain.handle('cli:login', wrap(async () => api.login()));
  ipcMain.handle('cli:loginCancel', wrap(async () => api.cancelLogin()));
  ipcMain.handle('cli:defaultBackupPath', wrap(async () => ({ ok: true, ...api.defaultBackupPath() })));
  ipcMain.handle('cli:backup', wrap(async (payload = {}) => api.createBackup({ destination: payload.destination })));

  // --------------------------------------------------------------- túneis
  ipcMain.handle('tunnel:create', wrap(async (payload = {}) => {
    const result = await api.createTunnel({ name: payload.name, routes: payload.routes || [] });
    if (!result.ok) return result;

    const dns = [];
    if (payload.createDns && Array.isArray(payload.routes)) {
      for (const route of payload.routes) {
        if (!route.hostname) continue;
        const res = await api.routeDNS({ tunnel: payload.name, hostname: route.hostname });
        dns.push({ hostname: route.hostname, ...res });
      }
    }
    return { ...result, dns };
  }));

  ipcMain.handle('tunnel:delete', wrap(async (payload = {}) => {
    const result = await api.deleteTunnel({
      id: payload.id,
      name: payload.name,
      removeFiles: payload.removeFiles !== false,
    });
    if (result.ok && payload.name) {
      await services.removeUnit(payload.name).catch(() => {});
    }
    return result;
  }));

  ipcMain.handle('tunnel:config:read', wrap(async (name) => api.readConfig(name)));

  ipcMain.handle('tunnel:config:save', wrap(async (payload = {}) => api.saveConfig(payload.name, payload.content)));

  ipcMain.handle('tunnel:config:validate', wrap(async (name) => {
    const read = await api.readConfig(name);
    if (!read.ok) return read;
    const structural = configTools.validateConfigText(read.content);
    if (!structural.ok) return { ok: false, error: structural.problems.join('\n') };
    const res = await api.validateConfigFile(name);
    return res.ok ? { ok: true, output: res.output } : { ok: false, error: res.error };
  }));

  ipcMain.handle('tunnel:config:validateText', wrap(async (content) => {
    const structural = configTools.validateConfigText(content || '');
    if (!structural.ok) return { ok: false, error: structural.problems.join('\n') };
    return api.validateText(content || '');
  }));

  ipcMain.handle('tunnel:config:scaffold', wrap(async (payload = {}) => api.scaffoldConfig({
    name: payload.name,
    tunnelId: payload.tunnelId,
    routes: payload.routes || [],
    overwrite: payload.overwrite === true,
  })));

  ipcMain.handle('tunnel:config:backups', wrap(async (name) => ({ ok: true, backups: await api.listBackups(name) })));
  ipcMain.handle('tunnel:config:restore', wrap(async (payload = {}) => api.restoreBackup(payload.name, payload.file)));

  ipcMain.handle('tunnel:routes:list', wrap(async (name) => {
    const read = await api.readConfig(name);
    if (!read.ok) return read;
    return { ok: true, routes: configTools.listRoutes(read.content), content: read.content };
  }));

  ipcMain.handle('tunnel:routes:add', wrap(async (payload = {}) => {
    const read = await api.readConfig(payload.name);
    if (!read.ok) return read;
    const route = payload.route || {};
    if (!route.hostname && !route.port && !route.service) {
      return { ok: false, error: 'Informe hostname e porta.' };
    }
    if (route.hostname && !isValidHostname(route.hostname)) {
      return { ok: false, error: `Hostname inválido: ${route.hostname}` };
    }
    const updated = configTools.insertRoute(read.content, route);
    return api.saveConfig(payload.name, updated);
  }));

  ipcMain.handle('tunnel:routes:remove', wrap(async (payload = {}) => {
    const read = await api.readConfig(payload.name);
    if (!read.ok) return read;
    const removed = configTools.removeRoute(read.content, {
      hostname: payload.hostname,
      index: payload.index,
    });
    if (!removed.ok) return removed;
    return api.saveConfig(payload.name, removed.text);
  }));

  ipcMain.handle('tunnel:dns:route', wrap(async (payload = {}) => {
    const hostnames = Array.isArray(payload.hostnames)
      ? payload.hostnames
      : [payload.hostname].filter(Boolean);
    if (hostnames.length === 0) return { ok: false, error: 'Nenhum hostname informado.' };

    const results = [];
    for (const hostname of hostnames) {
      const res = await api.routeDNS({ tunnel: payload.tunnel, hostname });
      results.push({ hostname, ...res });
    }
    return {
      ok: results.every((r) => r.ok),
      results,
      error: results.filter((r) => !r.ok).map((r) => `${r.hostname}: ${r.error}`).join('\n') || null,
    };
  }));

  // ------------------------------------------------- execução manual (opção 6)
  ipcMain.handle('tunnel:run:start', wrap(async (payload = {}) => {
    const name = payload.tunnel;
    const check = await preflight(name);
    if (!check.ok) return check;

    const id = `run:${name}`;
    const res = runner.start({
      id,
      kind: 'tunnel-run',
      meta: { tunnel: name },
      cmd: api.getBinary(),
      args: ['--config', configPathFor(name), '--no-autoupdate', 'tunnel', 'run'],
      cwd: CONFIG_DIR,
    });
    return res.ok ? { ok: true, id } : res;
  }));
  ipcMain.handle('tunnel:run:stop', wrap(async (payload = {}) => {
    const id = `run:${payload.tunnel}`;
    const res = runner.stop(id);
    return res.ok ? res : { ok: true, warning: res.error };
  }));
  ipcMain.handle('tunnel:run:buffer', wrap(async (payload = {}) => ({
    ok: true,
    output: runner.buffer(`run:${payload.tunnel}`),
    running: runner.has(`run:${payload.tunnel}`),
  })));

  // -------------------------------------------------------------- serviços
  ipcMain.handle('service:capabilities', wrap(async () => ({ ok: true, ...(await services.capabilities()) })));
  ipcMain.handle('service:mode:set', wrap(async (mode) => ({
    ok: true, mode: services.setMode(mode), ...(await services.capabilities()),
  })));

  ipcMain.handle('service:start', wrap(async (name) => {
    const check = await preflight(name);
    if (!check.ok) return check;
    // Cria a unidade se preciso, mas sem ativar autostart (ação separada).
    return services.startOrInstall(name);
  }));

  ipcMain.handle('service:stop', wrap(async (name) => services.stop(name)));

  ipcMain.handle('service:restart', wrap(async (name) => {
    const check = await preflight(name);
    if (!check.ok) return check;
    const status = await services.status(name);
    if (!status.installed) return services.startOrInstall(name);
    return services.restart(name);
  }));

  ipcMain.handle('service:enable', wrap(async (name) => {
    const check = await preflight(name);
    if (!check.ok) return check;
    return services.enable(name);
  }));

  ipcMain.handle('service:disable', wrap(async (name) => services.disable(name)));
  ipcMain.handle('service:remove', wrap(async (name) => services.removeUnit(name)));
  ipcMain.handle('service:status', wrap(async (name) => ({ ok: true, ...(await services.status(name)) })));
  ipcMain.handle('service:logs', wrap(async (payload = {}) => services.logs(
    payload.tunnel,
    { lines: payload.lines || settings.get('logLines') || 200 },
  )));

  ipcMain.handle('service:logs:follow', wrap(async (payload = {}) => {
    const name = payload.tunnel;
    const resolved = await services.resolve(name);
    const { cmd, args } = resolved.impl.logCommand(name, { lines: payload.lines || 120, follow: true });
    const id = `logs:${name}`;
    runner.stop(id);
    runner.dispose(id);
    const res = runner.start({
      id,
      kind: 'log-follow',
      meta: { tunnel: name, mode: resolved.mode },
      cmd,
      args,
    });
    return res.ok ? { ok: true, id } : res;
  }));

  ipcMain.handle('service:logs:unfollow', wrap(async (payload = {}) => {
    const id = `logs:${payload.tunnel}`;
    runner.stop(id);
    return { ok: true };
  }));

  // -------------------------------------------------------- desinstalar tudo
  ipcMain.handle('system:removeAllUnits', wrap(async () => {
    const removed = await services.removeAll();
    return { ok: true, removed };
  }));

  ipcMain.handle('system:pathInfo', wrap(async () => ({
    ok: true,
    configDir: CONFIG_DIR,
    configPathExample: configPathFor('<tunnel>'),
    backpackDir: path.join(os.homedir(), 'cloudflared-backups'),
  })));
}

module.exports = { registerIpc };
