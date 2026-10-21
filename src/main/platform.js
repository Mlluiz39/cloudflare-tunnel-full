'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const {
  CONFIG_DIR,
  CERT_FILE,
  configPathFor,
  credentialsPathFor,
  findInstalledBinary,
} = require('./paths');
const configTools = require('./config');

/**
 * Fachada de plataforma: junta o estado do CLI, dos arquivos locais e do
 * serviço do SO em um modelo único que o renderer consome.
 */
class PlatformService {
  constructor({ api, services, settings }) {
    this.api = api;
    this.services = services;
    this.settings = settings;
    this.type = process.platform;
  }

  environment() {
    const capabilities = this.services.privilege ? this.services.privilege.capabilities() : null;
    return {
      platform: this.type,
      platformLabel: {
        linux: 'Linux',
        darwin: 'macOS',
        win32: 'Windows',
      }[this.type] || this.type,
      arch: process.arch,
      homedir: os.homedir(),
      configDir: CONFIG_DIR,
      certFile: CERT_FILE,
      binary: findInstalledBinary(),
      serviceMode: this.services.mode,
      privilege: capabilities,
      settings: this.settings.all(),
    };
  }

  /** Lê o YAML local sem estourar caso o arquivo esteja corrompido. */
  async inspectConfig(tunnel) {
    const configPath = configPathFor(tunnel);
    try {
      const [content, stat] = await Promise.all([
        fsp.readFile(configPath, 'utf8'),
        fsp.stat(configPath),
      ]);
      const parsed = configTools.parseConfig(content);
      const structural = configTools.validateConfigText(content);
      return {
        exists: true,
        path: configPath,
        mtime: stat.mtimeMs,
        tunnelId: parsed.tunnelId,
        credentialsFile: parsed.credentialsFile,
        routes: configTools.listRoutes(content),
        valid: structural.ok,
        problems: structural.problems,
      };
    } catch (error) {
      return {
        exists: false,
        path: configPath,
        error: error.code === 'ENOENT' ? null : error.message,
        routes: [],
        valid: false,
        problems: [],
      };
    }
  }

  async inspectCredentials(id) {
    const credentialsPath = credentialsPathFor(id);
    try {
      const stat = await fsp.stat(credentialsPath);
      return { exists: true, path: credentialsPath, size: stat.size };
    } catch {
      return { exists: false, path: credentialsPath };
    }
  }

  buildWarnings({ config, credentials, service, tunnelId }) {
    const warnings = [];

    if (!config.exists) {
      warnings.push('Sem configuração local (.yml): não é possível executar o serviço.');
    } else {
      if (!config.valid) {
        warnings.push(`Configuração inválida: ${(config.problems || []).join(' ')}`);
      }
      if (config.tunnelId && tunnelId && config.tunnelId !== tunnelId) {
        warnings.push(
          `A configuração aponta para outro túnel (${config.tunnelId.slice(0, 8)}…), `
          + `mas este túnel é ${tunnelId.slice(0, 8)}….`,
        );
      }
      const hasRoutes = (config.routes || []).length > 0;
      if (!hasRoutes) {
        warnings.push('Nenhuma rota de ingress: o túnel só devolve 404.');
      }
    }

    if (!credentials.exists) {
      warnings.push(
        'Credenciais (.json) ausentes: o túnel foi criado em outra máquina ou a exclusão do arquivo '
        + 'foi manual. O cloudflared só gera esse arquivo ao executar `tunnel create` — sem ele o túnel '
        + 'não conecta. Alternativa: recrie o túnel por esta GUI.',
      );
    }

    if (service && service.installed && !service.running) {
      warnings.push(`Serviço instalado mas parado (${service.state || 'inativo'}).`);
    }
    if (service && service.installed && service.mode && service.mode !== this.services.mode) {
      warnings.push(`O serviço está no modo "${service.mode}" (fora do modo atual "${this.services.mode}").`);
    }

    return warnings;
  }

  /** Tudo o que o dashboard precisa em uma única chamada. */
  async overview() {
    const cli = await this.api.status();
    const remote = await this.api.listTunnels();

    const tunnels = Array.isArray(remote.tunnels) ? remote.tunnels : [];
    const statuses = await this.services.statusMany(tunnels.map((tunnel) => tunnel.name)).catch(() => ({}));

    const enriched = await Promise.all(tunnels.map(async (tunnel) => {
      const [config, credentials] = await Promise.all([
        this.inspectConfig(tunnel.name),
        this.inspectCredentials(tunnel.id),
      ]);
      const service = statuses[tunnel.name] || {
        installed: false, running: false, enabled: false, state: 'ausente', mode: this.services.mode,
      };
      return {
        id: tunnel.id,
        name: tunnel.name,
        createdAt: tunnel.createdAt,
        connectionsCount: Array.isArray(tunnel.connections) ? tunnel.connections.length : 0,
        config,
        credentials,
        service,
        warnings: this.buildWarnings({
          config, credentials, service, tunnelId: tunnel.id,
        }),
      };
    }));

    const orphans = await this.findOrphanConfigs(tunnels);

    return {
      cli: {
        installed: cli.installed,
        version: cli.version,
        binary: cli.binary,
        authenticated: cli.authenticated,
        configDir: cli.configDir,
      },
      listError: remote.ok ? null : remote.error,
      tunnels: enriched,
      orphans,
      serviceMode: this.services.mode,
      platform: this.environment(),
    };
  }

  /** Arquivos .yml que não correspondem a nenhum túnel remoto. */
  async findOrphanConfigs(remoteTunnels = []) {
    let entries = [];
    try {
      entries = await fsp.readdir(CONFIG_DIR);
    } catch {
      return [];
    }

    const knownIds = new Set(remoteTunnels.map((tunnel) => tunnel.id));
    const knownNames = new Set(remoteTunnels.map((tunnel) => tunnel.name));
    const orphans = [];

    for (const entry of entries) {
      if (!entry.endsWith('.yml')) continue;
      const name = entry.replace(/\.yml$/, '');
      const fullPath = path.join(CONFIG_DIR, entry);
      let content = '';
      try {
        content = await fsp.readFile(fullPath, 'utf8');
      } catch {
        continue;
      }
      const parsed = configTools.parseConfig(content);
      const tunnelId = parsed.tunnelId || null;
      const hasRemote = tunnelId ? knownIds.has(tunnelId) : knownNames.has(name);
      if (!hasRemote) {
        orphans.push({
          name,
          path: fullPath,
          tunnelId,
          reason: tunnelId
            ? 'O túnel referenciado no YAML não existe mais na conta.'
            : 'O YAML não tem a chave "tunnel:".',
        });
      }
    }

    return orphans;
  }

  /** Compatibilidade com chamadas antigas. */
  async list() {
    const overview = await this.overview();
    return overview.tunnels;
  }

  certExists() {
    try {
      return fs.statSync(CERT_FILE).isFile();
    } catch {
      return false;
    }
  }
}

module.exports = { PlatformService };
