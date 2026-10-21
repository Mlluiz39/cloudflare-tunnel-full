'use strict';

const { Settings } = require('./settings');
const { Privilege } = require('./privilege');
const { CloudflaredAPI } = require('./cloudflared');
const { CloudflareAPI } = require('./cloudflare-api');
const { ServiceManager } = require('./services');
const { PlatformService } = require('./platform');
const { TaskRunner } = require('./runner');
const { Publisher } = require('./publish');

/**
 * Monta o grafo de serviços do processo principal.
 * Usado pelo main.js e pelos scripts de teste/smoke.
 */
function createContext({ onEvent = () => {}, settingsDir }) {
  const settings = new Settings(settingsDir);
  const privilege = new Privilege();
  const api = new CloudflaredAPI({ onEvent, privilege });
  const cloudflare = new CloudflareAPI({ onEvent });
  const services = new ServiceManager({ privilege, settings, cloudflaredAPI: api });
  const platform = new PlatformService({ api, services, settings });
  const runner = new TaskRunner({ onEvent });
  const publisher = new Publisher({
    api, cloudflare, services, onEvent,
  });

  return {
    settings,
    privilege,
    api,
    cloudflare,
    services,
    platform,
    runner,
    publisher,
  };
}

module.exports = { createContext };
