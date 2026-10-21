'use strict';

const fs = require('fs');

const { configPathFor, credentialsPathFor } = require('./paths');
const configTools = require('./config');

/**
 * Checagem antes de subir/iniciar um serviço: o YAML existe, é válido, tem
 * credenciais e o próprio cloudflared aceita a configuração.
 * Compartilhado entre o IPC e o fluxo de publicação de subdomínio.
 */
async function preflight(api, name) {
  const configPath = configPathFor(name);
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      error: `Falta ${configPath}. Crie/edite a configuração do túnel primeiro.`,
    };
  }

  const read = await api.readConfig(name);
  if (!read.ok) return { ok: false, error: read.error };

  const structural = configTools.validateConfigText(read.content);
  if (!structural.ok) {
    return { ok: false, error: `Configuração inválida:\n${structural.problems.join('\n')}` };
  }

  const parsed = configTools.parseConfig(read.content);
  const credentialsFile = parsed.credentialsFile || credentialsPathFor(parsed.tunnelId || '');
  if (!fs.existsSync(credentialsFile)) {
    return {
      ok: false,
      credentialsMissing: true,
      error: `Credenciais ausentes (${credentialsFile}). Sem esse arquivo o túnel não conecta.`,
    };
  }

  const remote = await api.validateConfigFile(name);
  if (!remote.ok) {
    return { ok: false, error: `cloudflared recusou a configuração:\n${remote.error}` };
  }

  return { ok: true, parsed, configPath };
}

module.exports = { preflight };
