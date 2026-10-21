'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

/**
 * Diretório padrão da Cloudflare, igual ao usado pelo script bash
 * (~/.cloudflared). Pode ser sobrescrito por variável de ambiente,
 * o que é útil para testes.
 */
const CONFIG_DIR = process.env.CLOUDFLARED_HOME
  ? path.resolve(process.env.CLOUDFLARED_HOME)
  : path.join(os.homedir(), '.cloudflared');

/** Arquivo de certificado gerado por `cloudflared tunnel login`. */
const CERT_FILE = path.join(CONFIG_DIR, 'cert.pem');

const SERVICE_PREFIX = 'cloudflared-manager@';
const USER_UNIT_PREFIX = 'cloudflared-';

/** Nome válido de túnel: exatamente o mesmo regex do script bash. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

/** Hostname: mesma ideia do bash, rejeitando também '..' e underscores. */
const HOSTNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/;

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function isValidHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  const value = hostname.trim();
  if (!HOSTNAME_RE.test(value)) return false;
  if (value.includes('..')) return false;
  if (value.length > 253) return false;
  // Cada label tem no máximo 63 caracteres e não começa/termina com hífen.
  return value.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
  ));
}

function isValidPort(port) {
  const raw = String(port).trim();
  if (!/^\d+$/.test(raw)) return false;
  const value = Number.parseInt(raw, 10);
  return value >= 1 && value <= 65535;
}

function getBinaryName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fromPath() {
  const binary = getBinaryName();
  const separator = process.platform === 'win32' ? ';' : ':';
  const entries = (process.env.PATH || '').split(separator).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, binary);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function fromWhich() {
  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(command, [getBinaryName()], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first && isExecutableFile(first)) return first;
  } catch {
    /* ignora: binário ausente */
  }
  return null;
}

/**
 * Localiza o binário cloudflared. A ordem importa: primeiro o que o PATH
 * realmente resolve (mesma semântica do `command -v` do bash), depois
 * caminhos conhecidos por plataforma.
 */
function findInstalledBinary() {
  const direct = fromPath();
  if (direct) return direct;

  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', getBinaryName()),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', getBinaryName()),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cloudflared', getBinaryName()),
      path.join(CONFIG_DIR, getBinaryName()),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      path.join(home, '.cloudflared', 'cloudflared'),
    );
  } else {
    candidates.push(
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      '/snap/bin/cloudflared',
      path.join(home, '.local', 'bin', 'cloudflared'),
      path.join(CONFIG_DIR, 'cloudflared'),
    );
  }

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }

  const which = fromWhich();
  if (which) return which;

  // Último recurso: deixa o SO resolver (falha de forma explícita depois).
  return getBinaryName();
}

function configPathFor(name) {
  return path.join(CONFIG_DIR, `${name}.yml`);
}

function credentialsPathFor(id) {
  return path.join(CONFIG_DIR, `${id}.json`);
}

async function ensureConfigDir() {
  const fsp = fs.promises;
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    await fsp.chmod(CONFIG_DIR, 0o700);
  } catch {
    /* alguns FS (ex.: FAT) não suportam chmod */
  }
}

function ensureConfigDirSync() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* ignora */
  }
}

/** Caminho do ícone, independente de estar em dev ou empacotado. */
function iconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
    path.join(process.resourcesPath || '', 'assets', 'icon.png'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

module.exports = {
  CONFIG_DIR,
  CERT_FILE,
  SERVICE_PREFIX,
  USER_UNIT_PREFIX,
  isValidName,
  isValidHostname,
  isValidPort,
  getBinaryName,
  findInstalledBinary,
  isExecutableFile,
  configPathFor,
  credentialsPathFor,
  ensureConfigDir,
  ensureConfigDirSync,
  iconPath,
};
