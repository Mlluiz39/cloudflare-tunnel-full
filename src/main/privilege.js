'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Executa comandos privilegiados de forma gráfica:
 *   1. se já formos root, executa direto;
 *   2. `pkexec` (polkit) quando disponível — mostra a janela nativa do sistema;
 *   3. `sudo -n` (sem senha, ex.: regra NOPASSWD);
 *   4. `sudo -A` com um helper gráfico de senha (zenity/ksshaskpass/ssh-askpass).
 * Nada é executado com `stdio: inherit`, porque o app não tem TTY.
 */

function commandExists(command) {
  const separator = process.platform === 'win32' ? ';' : ':';
  const entries = (process.env.PATH || '').split(separator).filter(Boolean);
  const exts = process.platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '']
    : [''];
  for (const entry of entries) {
    for (const ext of exts) {
      try {
        const full = path.join(entry, command + ext);
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* continua */
      }
    }
  }
  return null;
}

function isRoot() {
  if (process.platform === 'win32') return false;
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function findAskpass() {
  const candidates = [
    process.env.SUDO_ASKPASS,
    '/usr/bin/zenity',
    '/usr/bin/ksshaskpass',
    '/usr/bin/ssh-askpass',
    '/usr/lib/ssh/ssh-askpass',
    '/usr/libexec/openssh/gnome-ssh-askpass',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const name = path.basename(candidate);
      if (name === 'zenity') return { kind: 'zenity', path: candidate };
      return { kind: 'askpass', path: candidate };
    }
  }
  return null;
}

/**
 * Gera um script SUDO_ASKPASS que usa zenity quando o binário disponível
 * for o próprio zenity (que espera `--password`, não um prompt).
 */
function buildAskpassScript(askpass) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-askpass-'));
  const scriptPath = path.join(dir, 'askpass.sh');
  const body = askpass.kind === 'zenity'
    ? `#!/bin/sh\nexec "${askpass.path}" --password --title "$1" 2>/dev/null\n`
    : `#!/bin/sh\nexec "${askpass.path}" "$1" 2>/dev/null\n`;
  fs.writeFileSync(scriptPath, body, { mode: 0o700 });
  return { scriptPath, dir };
}

class Privilege {
  constructor() {
    this.platform = process.platform;
    this.pkexec = this.platform === 'linux' ? commandExists('pkexec') : null;
    this.sudo = this.platform === 'linux' ? commandExists('sudo') : null;
    this.askpass = this.platform === 'linux' ? findAskpass() : null;
    this._askpassScript = null;
  }

  capabilities() {
    const root = isRoot();
    return {
      isRoot: root,
      hasPkexec: Boolean(this.pkexec),
      hasSudo: Boolean(this.sudo),
      hasGraphicalPrompt: Boolean(this.pkexec) || Boolean(this.askpass),
      // system mode precisa de root de alguma forma
      canSystemMode: this.platform !== 'linux'
        ? true
        : root || Boolean(this.pkexec) || Boolean(this.sudo),
      method: root ? 'root' : (this.pkexec ? 'pkexec' : (this.askpass ? 'sudo-askpass' : (this.sudo ? 'sudo' : 'none'))),
    };
  }

  _ensureAskpassScript() {
    if (!this._askpassScript && this.askpass) {
      const built = buildAskpassScript(this.askpass);
      this._askpassScript = built;
    }
    return this._askpassScript;
  }

  runShell(command, timeout = 120000) {
    return this.run('/bin/sh', ['-c', command], { timeout });
  }

  /**
   * Executa um comando com privilégio. Retorna sempre um objeto
   * { ok, stdout, stderr, code, error } — nunca lança.
   */
  run(command, args = [], options = {}) {
    const { timeout = 120000, env: extraEnv = {}, cwd } = options;

    const buildAttempts = () => {
      if (isRoot()) {
        return [{ cmd: command, args, env: {} }];
      }
      if (this.platform !== 'linux') {
        // macOS/Windows: sem elevação automática por aqui.
        return [{ cmd: command, args, env: {} }];
      }
      const attempts = [];
      if (this.pkexec) {
        attempts.push({ cmd: this.pkexec, args: [command, ...args], env: {} });
      }
      if (this.sudo) {
        attempts.push({ cmd: this.sudo, args: ['-n', command, ...args], env: {} });
        const askpass = this._ensureAskpassScript();
        if (askpass) {
          attempts.push({
            cmd: this.sudo,
            args: ['-A', command, ...args],
            env: { SUDO_ASKPASS: askpass.scriptPath },
          });
        }
      }
      return attempts;
    };

    const attempts = buildAttempts();
    if (attempts.length === 0) {
      return Promise.resolve({
        ok: false,
        code: 'E_NO_PRIVILEGE',
        error: 'Não há mecanismo de elevação disponível (pkexec/sudo).',
        stdout: '',
        stderr: '',
      });
    }

    const attempt = (index) => new Promise((resolve) => {
      if (index >= attempts.length) {
        resolve({
          ok: false,
          code: 'E_AUTH',
          error: 'Autenticação administrativa cancelada ou negada.',
          stdout: '',
          stderr: '',
        });
        return;
      }

      const current = attempts[index];
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let child;
      try {
        child = spawn(current.cmd, current.args, {
          cwd,
          env: { ...process.env, ...current.env, ...extraEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        settle({ ok: false, code: 'E_SPAWN', error: error.message, stdout: '', stderr: '' });
        return;
      }

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignora */ }
      }, timeout);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('error', (error) => {
        clearTimeout(timer);
        settle({ ok: false, code: 'E_SPAWN', error: error.message, stdout, stderr });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          settle({ ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0, method: current.cmd });
          return;
        }
        // O usuário cancelou a janela de autorização: insistir com outro
        // mecanismo só geraria um segundo prompt. Paramos aqui.
        const cancelled = /dismissed|canceled|cancelled|not authorized|access denied|authentication failed/i.test(stderr);
        if (cancelled) {
          settle({
            ok: false,
            code: 'E_AUTH_CANCELLED',
            error: 'Autorização administrativa cancelada.',
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            method: current.cmd,
          });
          return;
        }
        // 126/127 sem mensagem de cancelamento: o mecanismo não serve nesta
        // sessão (ex.: pkexec sem agente polkit). Tentamos o próximo.
        const authish = code === 126 || code === 127;
        if (authish && index + 1 < attempts.length) {
          attempt(index + 1).then(settle);
          return;
        }
        settle({
          ok: false,
          code,
          error: (stderr || stdout || `Comando falhou (código ${code})`).trim(),
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          method: current.cmd,
        });
      });
    });

    return attempt(0);
  }

  /** Escreve um arquivo em local protegido (ex.: /etc/systemd/system/...). */
  async writeFile(destination, content, mode = 0o644) {
    if (isRoot() || this.platform !== 'linux') {
      await fs.promises.writeFile(destination, content, { mode });
      return { ok: true, direct: true };
    }

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ctm-unit-'));
    const tempFile = path.join(dir, path.basename(destination));
    try {
      await fs.promises.writeFile(tempFile, content, { mode: 0o600 });
      return await this.run('install', ['-m', mode.toString(8), '-o', 'root', '-g', 'root', tempFile, destination]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async removeFile(destination) {
    if (isRoot() || this.platform !== 'linux') {
      await fs.promises.rm(destination, { force: true });
      return { ok: true, direct: true };
    }
    return this.run('rm', ['-f', destination]);
  }
}

module.exports = { Privilege, commandExists, isRoot };
