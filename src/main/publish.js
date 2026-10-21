'use strict';

const fs = require('fs');

const { isValidName, isValidHostname, isValidPort, configPathFor } = require('./paths');
const configTools = require('./config');
const checkup = require('./checkup');
const { preflight } = require('./preflight');

/**
 * "Criar subdomínio" em um passo: monta o hostname, garante o túnel, grava o
 * ingress, cria o DNS, sobe o serviço e testa o resultado.
 *
 * Cada etapa é publicada como evento para a interface desenhar a linha do
 * tempo — é isso que torna o processo visual em vez de um prompt de terminal.
 */
class Publisher {
  constructor({
    api, cloudflare, services, onEvent = () => {}, checker = checkup,
  }) {
    this.api = api;
    this.cloudflare = cloudflare;
    this.services = services;
    this.checker = checker;
    this.onEvent = onEvent;
  }

  emit(channel, payload) {
    try {
      this.onEvent(channel, payload);
    } catch {
      /* listener quebrado não deve derrubar o fluxo */
    }
  }

  _createStepTracker() {
    const steps = [];
    const publisher = this;
    return {
      steps,
      add(id, label) {
        const step = {
          id, label, state: 'pending', detail: '',
        };
        steps.push(step);
        this.emitStep(step);
        return step;
      },
      emitStep(step) {
        publisher.emit('publish:step', { ...step });
      },
      update(step, patch) {
        Object.assign(step, patch);
        this.emitStep(step);
      },
      run(step) {
        this.update(step, { state: 'running' });
      },
      ok(step, detail = '') {
        this.update(step, { state: 'ok', detail });
      },
      warn(step, detail = '') {
        this.update(step, { state: 'warn', detail });
      },
      fail(step, detail = '') {
        this.update(step, { state: 'error', detail });
      },
      skip(step, detail = '') {
        this.update(step, { state: 'skipped', detail });
      },
    };
  }

  /**
   * @param {object} payload
   * @param {string} payload.subdomain  rótulo (ex.: "api") ou hostname completo
   * @param {string} payload.domain     domínio escolhido (ex.: "exemplo.com.br")
   * @param {number} payload.port       porta local
   * @param {string} payload.scheme     http | https
   * @param {string} [payload.path]     filtro de path opcional
   * @param {string} payload.tunnelMode 'new' | 'existing'
   * @param {string} [payload.tunnelName]
   * @param {string} [payload.existingTunnel]
   * @param {boolean} [payload.createDns]
   * @param {boolean} [payload.startService]
   * @param {boolean} [payload.enableAutostart]
   */
  async publishSubdomain(payload = {}) {
    const tracker = this._createStepTracker();
    const warnings = [];

    const subdomain = String(payload.subdomain || '').trim().toLowerCase();
    const domain = String(payload.domain || '').trim().toLowerCase().replace(/^\.+/, '');
    const hostname = subdomain.includes('.') && !domain
      ? subdomain
      : (subdomain && domain ? `${subdomain}.${domain}` : subdomain);

    const createDns = payload.createDns !== false;
    const startService = payload.startService !== false;
    const enableAutostart = payload.enableAutostart === true;
    const scheme = payload.scheme === 'https' ? 'https' : 'http';
    const port = String(payload.port || '').trim();
    const routePath = String(payload.path || '').trim();

    // ---------------------------------------------------------------- 1
    const inputStep = tracker.add('input', 'Validar dados do subdomínio');
    tracker.run(inputStep);
    if (!hostname || !hostname.includes('.')) {
      tracker.fail(inputStep, 'Informe o subdomínio e escolha o domínio.');
      return this._finish(tracker, { ok: false, hostname, warnings });
    }
    if (!isValidHostname(hostname)) {
      tracker.fail(inputStep, `Hostname inválido: "${hostname}".`);
      return this._finish(tracker, { ok: false, hostname, warnings });
    }
    if (!isValidPort(port)) {
      tracker.fail(inputStep, `Porta inválida: "${port}". Use um número entre 1 e 65535.`);
      return this._finish(tracker, { ok: false, hostname, warnings });
    }
    tracker.ok(inputStep, hostname);

    // ---------------------------------------------------------------- 2
    const zoneStep = tracker.add('zone', 'Conferir domínio autorizado');
    tracker.run(zoneStep);
    const authority = await this.cloudflare.checkHostnameAuthority(hostname);
    if (authority.known && !authority.authorized) {
      const allowed = authority.zones.map((zone) => zone.name).join(', ') || '(nenhum domínio)';
      tracker.fail(
        zoneStep,
        `Este login autoriza: ${allowed}. Para usar ${hostname}, clique em "Autenticar" e escolha `
        + 'o domínio certo no navegador (o cert.pem guarda um domínio por vez).',
      );
      return this._finish(tracker, { ok: false, hostname, warnings });
    }
    if (!authority.known) {
      tracker.warn(zoneStep, authority.error || 'Não foi possível confirmar o domínio (seguindo mesmo assim).');
    } else {
      tracker.ok(zoneStep, authority.zone ? authority.zone.name : hostname);
    }

    // ---------------------------------------------------------------- 3
    const localStep = tracker.add('local', `Conferir serviço local na porta ${port}`);
    tracker.run(localStep);
    const local = await this.checker.checkLocalService({ port, scheme });
    if (!local.listening) {
      tracker.warn(localStep, local.error || 'Nada escutando nessa porta.');
      warnings.push(`Porta ${port} sem serviço ativo: o subdomínio será criado, mas responderá 502 até você subir a aplicação.`);
    } else if (local.warning) {
      tracker.warn(localStep, local.warning);
      warnings.push(local.warning);
    } else {
      tracker.ok(localStep, `HTTP ${local.httpStatus} em ${local.elapsedMs}ms`);
    }

    // ---------------------------------------------------------------- 4
    const tunnelStep = tracker.add('tunnel', 'Preparar túnel');
    tracker.run(tunnelStep);
    const route = {
      hostname, path: routePath, scheme, port,
    };

    let tunnelName = null;
    let createdTunnel = false;

    if (payload.tunnelMode === 'existing' && payload.existingTunnel) {
      tunnelName = String(payload.existingTunnel).trim();
      const read = await this.api.readConfig(tunnelName);
      if (!read.ok) {
        const scaffold = await this.api.scaffoldConfig({ name: tunnelName, routes: [] });
        if (!scaffold.ok) {
          tracker.fail(tunnelStep, scaffold.error);
          return this._finish(tracker, { ok: false, hostname, tunnel: tunnelName, warnings });
        }
        tracker.warn(tunnelStep, `${tunnelName}: YAML criado do zero.`);
      } else {
        const already = (read.routes || []).some((r) => r.hostname === hostname);
        if (already) {
          tracker.ok(tunnelStep, `${tunnelName}: rota já existia no YAML.`);
        } else {
          const updated = configTools.insertRoute(read.content, route);
          const saved = await this.api.saveConfig(tunnelName, updated);
          if (!saved.ok) {
            tracker.fail(tunnelStep, saved.error);
            return this._finish(tracker, { ok: false, hostname, tunnel: tunnelName, warnings });
          }
          tracker.ok(tunnelStep, `${tunnelName}: rota adicionada ao YAML.`);
        }
      }
    } else {
      tunnelName = String(payload.tunnelName || subdomain.split('.')[0]).trim();
      if (!isValidName(tunnelName)) {
        tracker.fail(tunnelStep, `Nome de túnel inválido: "${tunnelName}". Use letras, números, _ e -.`);
        return this._finish(tracker, { ok: false, hostname, warnings });
      }

      const existingId = await this.api.tunnelIdByName(tunnelName);
      if (existingId) {
        // Já existe: reaproveita em vez de falhar.
        const read = await this.api.readConfig(tunnelName);
        if (read.ok) {
          const already = (read.routes || []).some((r) => r.hostname === hostname);
          if (!already) {
            const updated = configTools.insertRoute(read.content, route);
            const saved = await this.api.saveConfig(tunnelName, updated);
            if (!saved.ok) {
              tracker.fail(tunnelStep, saved.error);
              return this._finish(tracker, { ok: false, hostname, tunnel: tunnelName, warnings });
            }
            tracker.warn(tunnelStep, `Túnel "${tunnelName}" já existia; rota adicionada.`);
          } else {
            tracker.warn(tunnelStep, `Túnel "${tunnelName}" já existia com essa rota.`);
          }
        } else {
          const scaffold = await this.api.scaffoldConfig({ name: tunnelName, routes: [route] });
          if (!scaffold.ok) {
            tracker.fail(tunnelStep, scaffold.error);
            return this._finish(tracker, { ok: false, hostname, tunnel: tunnelName, warnings });
          }
          tracker.warn(tunnelStep, `Túnel "${tunnelName}" existia sem YAML; configuração criada.`);
        }
      } else {
        const created = await this.api.createTunnel({ name: tunnelName, routes: [route] });
        if (!created.ok) {
          tracker.fail(tunnelStep, created.error);
          return this._finish(tracker, { ok: false, hostname, warnings });
        }
        createdTunnel = true;
        tracker.ok(tunnelStep, `Túnel "${tunnelName}" criado (${String(created.tunnelId).slice(0, 8)}…)`);
      }
    }

    // ---------------------------------------------------------------- 5
    const configStep = tracker.add('config', 'Validar ingress');
    tracker.run(configStep);
    const check = await preflight(this.api, tunnelName);
    if (!check.ok) {
      tracker.fail(configStep, check.error);
      return this._finish(tracker, {
        ok: false, hostname, tunnel: tunnelName, warnings,
      });
    }
    const routes = (check.parsed && check.parsed.ingress ? check.parsed.ingress : [])
      .filter((rule) => rule.hostname);
    tracker.ok(configStep, `${routes.length} rota(s) válidas em ${configPathFor(tunnelName)}`);

    // ---------------------------------------------------------------- 6
    const dnsStep = tracker.add('dns', 'Criar registro DNS');
    if (!createDns) {
      tracker.skip(dnsStep, 'Desmarcado.');
    } else {
      tracker.run(dnsStep);
      const existingRecord = await this.cloudflare.dnsRecordsFor(hostname);
      const tunnelId = await this.api.tunnelIdByName(tunnelName);
      const expectedTarget = tunnelId ? `${tunnelId}.cfargotunnel.com` : null;
      const match = existingRecord.ok
        ? existingRecord.records.find((record) => record.type === 'CNAME'
          && (!expectedTarget || record.content === expectedTarget))
        : null;

      if (match) {
        tracker.ok(dnsStep, `CNAME já existia → ${match.content}`);
      } else if (existingRecord.ok && existingRecord.records.length > 0) {
        const found = existingRecord.records[0];
        tracker.fail(
          dnsStep,
          `Já existe um registro ${found.type} para ${hostname} apontando para ${found.content}. `
          + 'Apague/ajuste esse registro no painel e tente de novo.',
        );
        warnings.push('DNS conflitante: o hostname aponta para outro destino.');
      } else {
        const routed = await this.api.routeDNS({ tunnel: tunnelName, hostname });
        if (routed.ok) {
          tracker.ok(dnsStep, `CNAME → ${expectedTarget || `${tunnelName}.cfargotunnel.com`}`);
        } else {
          tracker.fail(dnsStep, routed.error);
          warnings.push(`DNS não criado: ${routed.error}`);
        }
      }
    }

    // ---------------------------------------------------------------- 7
    const serviceStep = tracker.add('service', 'Serviço do sistema');
    if (!startService) {
      tracker.skip(serviceStep, 'Desmarcado.');
    } else {
      tracker.run(serviceStep);
      const started = await this.services.startOrInstall(tunnelName);
      if (!started.ok) {
        tracker.fail(serviceStep, started.error);
      } else if (enableAutostart) {
        const enabled = await this.services.enable(tunnelName);
        if (enabled.ok) {
          tracker.ok(serviceStep, `Rodando e ativado no boot${enabled.linger && enabled.linger.ok === false ? ' (linger pendente)' : ''}.`);
        } else {
          tracker.warn(serviceStep, `Rodando, mas não foi possível ativar no boot: ${enabled.error}`);
        }
      } else {
        tracker.ok(serviceStep, 'Serviço iniciado.');
      }
    }

    // ---------------------------------------------------------------- 8
    const probeStep = tracker.add('probe', 'Testar o subdomínio');
    const dnsReady = createDns && dnsStep.state === 'ok';
    if (!dnsReady) {
      tracker.skip(probeStep, 'Teste pulado (sem DNS criado nesta execução).');
    } else {
      tracker.run(probeStep);
      const probe = await this.checker.waitForPublicHostname(hostname);
      if (probe.ok) {
        tracker.ok(probeStep, `HTTPS ${probe.http.status} em ${probe.http.elapsedMs}ms`);
      } else {
        tracker.warn(probeStep, probe.error || 'Ainda não respondeu.');
        warnings.push('O teste público não confirmou o funcionamento ainda — pode ser propagação de DNS.');
      }
    }

    const failed = tracker.steps.some((step) => step.state === 'error');
    return this._finish(tracker, {
      ok: !failed,
      hostname,
      url: `https://${hostname}`,
      tunnel: tunnelName,
      createdTunnel,
      warnings,
    });
  }

  _finish(tracker, result) {
    const payload = {
      ...result,
      steps: tracker.steps.map((step) => ({ ...step })),
    };
    this.emit('publish:done', payload);
    return payload;
  }
}

module.exports = { Publisher };
