'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/**
 * API exposta ao renderer. Cada função devolve `{ ok, error?, ... }`,
 * então a interface não precisa de try/catch em volta do IPC.
 */
const api = {
  // ambiente / estado
  environment: () => invoke('app:environment'),
  overview: () => invoke('app:overview'),
  getSettings: () => invoke('app:settings:get'),
  setSettings: (patch) => invoke('app:settings:set', patch),
  appInfo: () => invoke('app:appInfo'),
  openConfigDir: () => invoke('app:openConfigDir'),
  openPath: (target) => invoke('app:openPath', target),
  removeOrphanConfig: (target) => invoke('app:removeOrphanConfig', target),
  openExternal: (url) => invoke('app:openExternal', url),
  saveDialog: (options) => invoke('app:saveDialog', options),
  pathInfo: () => invoke('system:pathInfo'),

  // CLI cloudflared
  cliStatus: () => invoke('cli:status'),
  install: () => invoke('cli:install'),
  uninstall: () => invoke('cli:uninstall'),
  login: () => invoke('cli:login'),
  cancelLogin: () => invoke('cli:loginCancel'),
  defaultBackupPath: () => invoke('cli:defaultBackupPath'),
  backup: (destination) => invoke('cli:backup', { destination }),

  // domínios e checagens
  listZones: () => invoke('zones:list'),
  checkLocal: (port, scheme) => invoke('check:local', { port, scheme }),
  checkHostname: (hostname) => invoke('check:hostname', { hostname }),

  // criação visual de subdomínio (uma ação)
  publishSubdomain: (payload) => invoke('publish:subdomain', payload),

  // túneis
  createTunnel: (payload) => invoke('tunnel:create', payload),
  deleteTunnel: (payload) => invoke('tunnel:delete', payload),
  readConfig: (name) => invoke('tunnel:config:read', name),
  saveConfig: (name, content) => invoke('tunnel:config:save', { name, content }),
  validateConfig: (name) => invoke('tunnel:config:validate', name),
  validateConfigText: (content) => invoke('tunnel:config:validateText', content),
  scaffoldConfig: (payload) => invoke('tunnel:config:scaffold', payload),
  listBackups: (name) => invoke('tunnel:config:backups', name),
  restoreBackup: (name, file) => invoke('tunnel:config:restore', { name, file }),
  listRoutes: (name) => invoke('tunnel:routes:list', name),
  addRoute: (name, route) => invoke('tunnel:routes:add', { name, route }),
  removeRoute: (name, target) => invoke('tunnel:routes:remove', { name, ...target }),
  routeDns: (payload) => invoke('tunnel:dns:route', payload),

  // execução manual
  startRun: (tunnel) => invoke('tunnel:run:start', { tunnel }),
  stopRun: (tunnel) => invoke('tunnel:run:stop', { tunnel }),
  runBuffer: (tunnel) => invoke('tunnel:run:buffer', { tunnel }),

  // serviços do SO
  serviceCapabilities: () => invoke('service:capabilities'),
  setServiceMode: (mode) => invoke('service:mode:set', mode),
  startService: (name) => invoke('service:start', name),
  stopService: (name) => invoke('service:stop', name),
  restartService: (name) => invoke('service:restart', name),
  enableService: (name) => invoke('service:enable', name),
  disableService: (name) => invoke('service:disable', name),
  removeServiceUnit: (name) => invoke('service:remove', name),
  serviceStatus: (name) => invoke('service:status', name),
  serviceLogs: (tunnel, lines) => invoke('service:logs', { tunnel, lines }),
  followLogs: (tunnel, lines) => invoke('service:logs:follow', { tunnel, lines }),
  unfollowLogs: (tunnel) => invoke('service:logs:unfollow', { tunnel }),
  removeAllUnits: () => invoke('system:removeAllUnits'),

  /** Assina eventos do processo principal; devolve a função de cancelamento. */
  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ctm:event', listener);
    return () => ipcRenderer.removeListener('ctm:event', listener);
  },
};

contextBridge.exposeInMainWorld('ctm', api);
