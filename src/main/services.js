'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const {
  CONFIG_DIR,
  SERVICE_PREFIX,
  USER_UNIT_PREFIX,
  configPathFor,
  findInstalledBinary,
} = require('./paths');

const SYSTEM_UNIT_DIR = '/etc/systemd/system';
const SYSTEM_TEMPLATE = `${SERVICE_PREFIX}.service`;

function run(cmd, args, options = {}) {
  const { timeout = 60000, env = {} } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: error.message, code: 'E_SPAWN', stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignora */ }
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, code: 'E_SPAWN', stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: code === 0 && !timedOut
          ? null
          : (stderr.trim() || stdout.trim() || (timedOut ? 'Tempo esgotado' : `Código ${code}`)),
      });
    });
  });
}

function parseShowOutput(output) {
  const result = {};
  for (const line of String(output || '').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

/** Interpreta `systemctl show`. LoadState=not-found é o sinal de "não existe". */
function statusFromShow(output, unit) {
  const parsed = parseShowOutput(output);
  const loadState = parsed.LoadState || '';
  const activeState = parsed.ActiveState || 'inactive';
  const unitFileState = parsed.UnitFileState || 'disabled';
  const installed = loadState !== '' && loadState !== 'not-found';
  return {
    installed,
    running: installed && ['active', 'activating', 'reloading'].includes(activeState),
    enabled: unitFileState === 'enabled',
    state: installed ? activeState : 'ausente',
    unitFileState,
    loadState,
    unit,
    detail: installed ? `${activeState} / ${unitFileState}` : 'não instalado',
  };
}

function systemdUnitContent({ description, execStart, workingUser = null, home = null, hardening = 'user' }) {
  const lines = [
    '[Unit]',
    `Description=${description}`,
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
  ];
  if (workingUser) lines.push(`User=${workingUser}`);
  if (home) lines.push(`Environment=HOME=${home}`);
  lines.push(`ExecStart=${execStart}`);
  lines.push('Restart=on-failure', 'RestartSec=5s');
  if (hardening === 'system') {
    lines.push('NoNewPrivileges=true', 'ProtectSystem=full', 'ProtectHome=false', 'PrivateTmp=true');
  } else {
    lines.push('NoNewPrivileges=true', 'PrivateTmp=true');
  }
  lines.push('', '[Install]');
  lines.push(hardening === 'system' ? 'WantedBy=multi-user.target' : 'WantedBy=default.target');
  lines.push('');
  return lines.join('\n');
}

/** systemd --user: sem senha, e com linger para subir no boot. */
class SystemdUserService {
  constructor({ privilege } = {}) {
    this.privilege = privilege;
    this.type = 'user';
    this.label = 'systemd (usuário)';
    this.unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    this.requiresPrivilege = false;
  }

  async available() {
    const res = await run('systemctl', ['--user', 'show-environment'], { timeout: 10000 });
    return {
      available: res.ok,
      reason: res.ok ? null : 'A sessão systemd do usuário não está acessível (systemctl --user falhou).',
    };
  }

  unitName(tunnel) {
    return `${USER_UNIT_PREFIX}${tunnel}.service`;
  }

  unitPath(tunnel) {
    return path.join(this.unitDir, this.unitName(tunnel));
  }

  async detect(tunnel) {
    const status = await this.status(tunnel);
    return status.installed;
  }

  async status(tunnel) {
    const unit = this.unitName(tunnel);
    const res = await run('systemctl', [
      '--user', 'show', unit,
      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState', '--no-pager',
    ], { timeout: 15000 });
    if (!res.ok) {
      return { installed: false, running: false, enabled: false, state: 'ausente', unit };
    }
    return statusFromShow(res.stdout, unit);
  }

  async writeUnit(tunnel, { binary = findInstalledBinary() } = {}) {
    await fsp.mkdir(this.unitDir, { recursive: true });
    const configPath = configPathFor(tunnel);
    const content = systemdUnitContent({
      description: `Cloudflare Tunnel Manager - ${tunnel}`,
      execStart: `"${binary}" --config "${configPath}" --no-autoupdate tunnel run`,
      home: os.homedir(),
      hardening: 'user',
    });
    await fsp.writeFile(this.unitPath(tunnel), content, { mode: 0o644 });
    const reload = await run('systemctl', ['--user', 'daemon-reload'], { timeout: 30000 });
    return { ok: reload.ok, error: reload.ok ? null : reload.error, unitPath: this.unitPath(tunnel) };
  }

  /** Cria/atualiza a unidade sem mexer no autostart. */
  async install(tunnel, options = {}) {
    return this.writeUnit(tunnel, options);
  }

  /** Liga no boot: enable + start + linger (para subir sem login). */
  async enable(tunnel) {
    const written = await this.writeUnit(tunnel);
    if (!written.ok) return written;

    const enabled = await run('systemctl', ['--user', 'enable', '--now', this.unitName(tunnel)], { timeout: 60000 });
    const linger = await this.ensureLinger();

    if (!enabled.ok) {
      return { ok: false, error: enabled.error, linger };
    }
    return { ok: true, linger, unitPath: written.unitPath };
  }

  async ensureLinger() {
    const user = os.userInfo().username;
    const check = await run('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { timeout: 10000 });
    if (check.ok && check.stdout.trim() === 'yes') {
      return { ok: true, linger: true, alreadyEnabled: true };
    }
    let res = await run('loginctl', ['enable-linger', user], { timeout: 30000 });
    if (!res.ok && this.privilege) {
      res = await this.privilege.run('loginctl', ['enable-linger', user], { timeout: 60000 });
    }
    return {
      ok: res.ok,
      linger: res.ok,
      error: res.ok ? null : `Não foi possível ativar o linger: ${res.error}. O túnel não subirá no boot sem login.`,
    };
  }

  async disable(tunnel) {
    const res = await run('systemctl', ['--user', 'disable', '--now', this.unitName(tunnel)], { timeout: 60000 });
    return { ok: res.ok || /No such file|not loaded/.test(res.error || ''), error: res.ok ? null : res.error };
  }

  async start(tunnel) {
    return run('systemctl', ['--user', 'start', this.unitName(tunnel)], { timeout: 60000 });
  }

  async stop(tunnel) {
    return run('systemctl', ['--user', 'stop', this.unitName(tunnel)], { timeout: 60000 });
  }

  async restart(tunnel) {
    await run('systemctl', ['--user', 'daemon-reload'], { timeout: 20000 });
    return run('systemctl', ['--user', 'restart', this.unitName(tunnel)], { timeout: 60000 });
  }

  async removeUnit(tunnel) {
    await run('systemctl', ['--user', 'disable', '--now', this.unitName(tunnel)], { timeout: 60000 });
    try {
      await fsp.rm(this.unitPath(tunnel), { force: true });
    } catch {
      /* ignora */
    }
    await run('systemctl', ['--user', 'daemon-reload'], { timeout: 20000 });
    await run('systemctl', ['--user', 'reset-failed', this.unitName(tunnel)], { timeout: 20000 });
    return { ok: true };
  }

  logCommand(tunnel, { lines = 200, follow = false } = {}) {
    const args = ['--user', '-u', this.unitName(tunnel), '-n', String(lines), '--no-pager', '-o', 'cat'];
    if (follow) args.push('-f');
    return { cmd: 'journalctl', args };
  }

  async listManaged() {
    const res = await run('systemctl', ['--user', 'list-unit-files', `${USER_UNIT_PREFIX}*.service`, '--no-legend', '--no-pager'], { timeout: 20000 });
    if (!res.ok) return [];
    return res.stdout.split('\n')
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean)
      .map((unit) => unit.replace(new RegExp(`^${USER_UNIT_PREFIX}`), '').replace(/\.service$/, ''));
  }
}

/** systemd de sistema, igual ao script bash (/etc/systemd/system + template). */
class SystemdSystemService {
  constructor({ privilege } = {}) {
    this.privilege = privilege;
    this.type = 'system';
    this.label = 'systemd (sistema)';
    this.unitDir = SYSTEM_UNIT_DIR;
    this.requiresPrivilege = true;
  }

  async available() {
    if (!this.privilege) return { available: false, reason: 'Sem gerenciador de privilégios.' };
    const capability = this.privilege.capabilities();
    const isRoot = capability.isRoot;
    return {
      available: isRoot || capability.hasGraphicalPrompt || capability.hasSudo,
      reason: isRoot || capability.hasGraphicalPrompt || capability.hasSudo
        ? null
        : 'Nenhum mecanismo de elevação (pkexec/sudo) disponível para gravar em /etc/systemd/system.',
      method: capability.method,
    };
  }

  unitName(tunnel) {
    return `${SERVICE_PREFIX}${tunnel}.service`;
  }

  unitPath() {
    return path.join(SYSTEM_UNIT_DIR, SYSTEM_TEMPLATE);
  }

  async detect(tunnel) {
    const status = await this.status(tunnel);
    return status.installed;
  }

  async status(tunnel) {
    const unit = this.unitName(tunnel);
    const res = await run('systemctl', [
      'show', unit,
      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState', '--no-pager',
    ], { timeout: 15000 });
    if (!res.ok) {
      return { installed: false, running: false, enabled: false, state: 'ausente', unit };
    }
    return statusFromShow(res.stdout, unit);
  }

  async writeUnit(tunnel, { binary = findInstalledBinary() } = {}) {
    const template = systemdUnitContent({
      description: 'Cloudflare Tunnel Manager - %i',
      execStart: `"${binary}" --config "${CONFIG_DIR}/%i.yml" --no-autoupdate tunnel run`,
      workingUser: os.userInfo().username,
      home: os.homedir(),
      hardening: 'system',
    });
    const written = await this.privilege.writeFile(this.unitPath(), template, 0o644);
    if (!written.ok) return { ok: false, error: written.error };
    const reload = await this.privilege.run('systemctl', ['daemon-reload'], { timeout: 60000 });
    return { ok: reload.ok, error: reload.ok ? null : reload.error, unitPath: this.unitPath() };
  }

  /** Cria/atualiza o template + unidade sem mexer no autostart. */
  async install(tunnel, options = {}) {
    return this.writeUnit(tunnel, options);
  }

  async enable(tunnel) {
    const written = await this.writeUnit(tunnel);
    if (!written.ok) return written;
    const res = await this.privilege.run('systemctl', ['enable', '--now', this.unitName(tunnel)], { timeout: 120000 });
    return { ok: res.ok, error: res.ok ? null : res.error, unitPath: written.unitPath };
  }

  async disable(tunnel) {
    const res = await this.privilege.run('systemctl', ['disable', '--now', this.unitName(tunnel)], { timeout: 120000 });
    return { ok: res.ok, error: res.ok ? null : res.error };
  }

  async start(tunnel) {
    return this.privilege.run('systemctl', ['start', this.unitName(tunnel)], { timeout: 120000 });
  }

  async stop(tunnel) {
    return this.privilege.run('systemctl', ['stop', this.unitName(tunnel)], { timeout: 120000 });
  }

  async restart(tunnel) {
    return this.privilege.run('systemctl', ['restart', this.unitName(tunnel)], { timeout: 120000 });
  }

  async removeUnit(tunnel) {
    await this.privilege.run('systemctl', ['disable', '--now', this.unitName(tunnel)], { timeout: 120000 });
    await this.privilege.run('systemctl', ['reset-failed', this.unitName(tunnel)], { timeout: 60000 });
    // O template só é removido explicitamente no "desinstalar"; aqui
    // mantemos para os outros túneis continuarem funcionando.
    return { ok: true };
  }

  async removeTemplate() {
    const res = await this.privilege.removeFile(this.unitPath());
    const reload = await this.privilege.run('systemctl', ['daemon-reload'], { timeout: 60000 });
    return { ok: res.ok && reload.ok, error: res.ok ? (reload.ok ? null : reload.error) : res.error };
  }

  logCommand(tunnel, { lines = 200, follow = false } = {}) {
    const args = ['-u', this.unitName(tunnel), '-n', String(lines), '--no-pager', '-o', 'cat'];
    if (follow) args.push('-f');
    return { cmd: 'journalctl', args };
  }

  async listManaged() {
    const res = await run('systemctl', ['list-unit-files', `${SERVICE_PREFIX}*.service`, '--no-legend', '--no-pager'], { timeout: 20000 });
    if (!res.ok) return [];
    return res.stdout.split('\n')
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean)
      .map((unit) => unit.replace(new RegExp(`^${SERVICE_PREFIX}`), '').replace(/\.service$/, ''));
  }
}

/** macOS launchd (LaunchAgents). */
class LaunchdService {
  constructor() {
    this.type = 'launchd';
    this.label = 'launchd';
    this.requiresPrivilege = false;
    this.plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  }

  async available() {
    return { available: process.platform === 'darwin', reason: null };
  }

  serviceLabel(tunnel) {
    return `com.cloudflared.manager.${tunnel}`;
  }

  plistPath(tunnel) {
    return path.join(this.plistDir, `${this.serviceLabel(tunnel)}.plist`);
  }

  logPath(tunnel) {
    return path.join(CONFIG_DIR, `${tunnel}.log`);
  }

  async detect(tunnel) {
    try {
      await fsp.access(this.plistPath(tunnel));
      return true;
    } catch {
      return false;
    }
  }

  async status(tunnel) {
    const label = this.serviceLabel(tunnel);
    const installed = await this.detect(tunnel);
    const res = await run('launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 15000 });
    const running = res.ok && /state = running/.test(res.stdout);
    return {
      installed,
      running,
      enabled: installed,
      state: running ? 'active' : (installed ? 'loaded' : 'ausente'),
      unit: label,
      detail: running ? 'running' : (installed ? 'carregado' : 'ausente'),
    };
  }

  async writeUnit(tunnel, { binary = findInstalledBinary() } = {}) {
    await fsp.mkdir(this.plistDir, { recursive: true });
    const label = this.serviceLabel(tunnel);
    const configPath = configPathFor(tunnel);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binary}</string>
    <string>--config</string>
    <string>${configPath}</string>
    <string>--no-autoupdate</string>
    <string>tunnel</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${this.logPath(tunnel)}</string>
  <key>StandardErrorPath</key>
  <string>${this.logPath(tunnel)}</string>
</dict>
</plist>
`;
    await fsp.writeFile(this.plistPath(tunnel), plist, { mode: 0o644 });
    return { ok: true, unitPath: this.plistPath(tunnel) };
  }

  async bootstrap(tunnel) {
    const domain = `gui/${process.getuid()}`;
    const first = await run('launchctl', ['bootstrap', domain, this.plistPath(tunnel)], { timeout: 60000 });
    if (first.ok) return first;
    return run('launchctl', ['load', '-w', this.plistPath(tunnel)], { timeout: 60000 });
  }

  async bootout(tunnel) {
    const domain = `gui/${process.getuid()}`;
    const first = await run('launchctl', ['bootout', `${domain}/${this.serviceLabel(tunnel)}`], { timeout: 60000 });
    if (first.ok) return first;
    return run('launchctl', ['unload', '-w', this.plistPath(tunnel)], { timeout: 60000 });
  }

  async install(tunnel, options = {}) {
    return this.writeUnit(tunnel, options);
  }

  async enable(tunnel) {
    const written = await this.writeUnit(tunnel);
    if (!written.ok) return written;
    const res = await this.bootstrap(tunnel);
    return { ok: res.ok, error: res.ok ? null : res.error, unitPath: written.unitPath };
  }

  async disable(tunnel) {
    await this.bootout(tunnel);
    try {
      await fsp.rm(this.plistPath(tunnel), { force: true });
    } catch {
      /* ignora */
    }
    return { ok: true };
  }

  async start(tunnel) {
    return this.bootstrap(tunnel);
  }

  async stop(tunnel) {
    return this.bootout(tunnel);
  }

  async restart(tunnel) {
    await this.bootout(tunnel);
    return this.bootstrap(tunnel);
  }

  async removeUnit(tunnel) {
    return this.disable(tunnel);
  }

  logCommand(tunnel, { lines = 200, follow = false } = {}) {
    const args = ['-n', String(lines)];
    if (follow) args.push('-f');
    args.push(this.logPath(tunnel));
    return { cmd: 'tail', args };
  }

  async listManaged() {
    try {
      const entries = await fsp.readdir(this.plistDir);
      return entries
        .filter((entry) => entry.startsWith('com.cloudflared.manager.') && entry.endsWith('.plist'))
        .map((entry) => entry.replace('com.cloudflared.manager.', '').replace('.plist', ''));
    } catch {
      return [];
    }
  }
}

/** Serviço do Windows via sc.exe, com elevação por UAC. */
class WindowsService {
  constructor() {
    this.type = 'windows';
    this.label = 'Serviço do Windows';
    this.requiresPrivilege = true;
  }

  async available() {
    return { available: process.platform === 'win32', reason: null };
  }

  serviceName(tunnel) {
    return `CloudflareTunnel_${tunnel}`;
  }

  elevate(commandLine) {
    const escaped = commandLine.replace(/'/g, "''");
    const powershell = [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','${escaped}'`,
    ];
    return run('powershell.exe', powershell, { timeout: 180000 });
  }

  async detect(tunnel) {
    const res = await run('sc.exe', ['query', this.serviceName(tunnel)], { timeout: 20000 });
    return res.ok;
  }

  async status(tunnel) {
    const name = this.serviceName(tunnel);
    const res = await run('sc.exe', ['query', name], { timeout: 20000 });
    const text = `${res.stdout}\n${res.stderr}`;
    const installed = res.ok && !/FAILED 1060/.test(text);
    const running = /STATE\s*:\s*\d+\s+RUNNING/.test(text);
    return {
      installed,
      running,
      enabled: installed,
      state: running ? 'active' : (installed ? 'stopped' : 'ausente'),
      unit: name,
      detail: running ? 'RUNNING' : (installed ? 'STOPPED' : 'ausente'),
    };
  }

  async install(tunnel, options = {}) {
    // No Windows não existe arquivo de unidade: criar o serviço já o registra.
    return this.enable(tunnel, options);
  }

  async enable(tunnel) {
    const name = this.serviceName(tunnel);
    const binary = findInstalledBinary();
    const configPath = configPathFor(tunnel);
    const binPath = `"${binary}" --config "${configPath}" --no-autoupdate tunnel run`;
    const command = [
      `sc.exe create ${name} binPath= '${binPath}' start= auto DisplayName= 'Cloudflare Tunnel (${tunnel})'`,
      `Start-Service -Name '${name}'`,
    ].join('; ');
    const res = await this.elevate(command);
    return { ok: res.ok, error: res.ok ? null : res.error };
  }

  async disable(tunnel) {
    const name = this.serviceName(tunnel);
    const command = [
      `Stop-Service -Name '${name}' -Force -ErrorAction SilentlyContinue`,
      `sc.exe delete ${name}`,
    ].join('; ');
    const res = await this.elevate(command);
    return { ok: res.ok, error: res.ok ? null : res.error };
  }

  async start(tunnel) {
    return run('sc.exe', ['start', this.serviceName(tunnel)], { timeout: 60000 });
  }

  async stop(tunnel) {
    return run('sc.exe', ['stop', this.serviceName(tunnel)], { timeout: 60000 });
  }

  async restart(tunnel) {
    await this.stop(tunnel);
    return this.start(tunnel);
  }

  async removeUnit(tunnel) {
    return this.disable(tunnel);
  }

  logCommand(tunnel, { lines = 200, follow = false } = {}) {
    const name = this.serviceName(tunnel);
    // Não há `journalctl` no Windows: lemos o Visualizador de Eventos.
    const args = [
      '-NoProfile',
      '-Command',
      `Get-EventLog -LogName Application -Source '${name}' -Newest ${lines} -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String -Width 200`,
    ];
    void follow;
    return { cmd: 'powershell.exe', args };
  }

  async listManaged() {
    const res = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      "(Get-Service -Name 'CloudflareTunnel_*' -ErrorAction SilentlyContinue).Name",
    ], { timeout: 30000 });
    if (!res.ok) return [];
    return res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .map((name) => name.replace('CloudflareTunnel_', ''));
  }
}

/**
 * Fachada: escolhe a implementação conforme o SO e o modo configurado,
 * e sabe detectar unidades criadas "no outro modo" (evita fantasmas).
 */
class ServiceManager {
  constructor({ privilege, settings, cloudflaredAPI }) {
    this.privilege = privilege;
    this.settings = settings;
    this.api = cloudflaredAPI;

    if (process.platform === 'linux') {
      this.userImpl = new SystemdUserService({ privilege });
      this.systemImpl = new SystemdSystemService({ privilege });
    } else if (process.platform === 'darwin') {
      this.userImpl = new LaunchdService();
      this.systemImpl = new LaunchdService();
    } else {
      this.userImpl = new WindowsService();
      this.systemImpl = new WindowsService();
    }
  }

  get mode() {
    if (process.platform !== 'linux') return 'user';
    const configured = this.settings.get('serviceMode');
    return configured === 'system' ? 'system' : 'user';
  }

  setMode(mode) {
    if (process.platform !== 'linux') return this.mode;
    this.settings.set({ serviceMode: mode === 'system' ? 'system' : 'user' });
    return this.mode;
  }

  impl(mode = this.mode) {
    return mode === 'system' ? this.systemImpl : this.userImpl;
  }

  async capabilities() {
    const modes = [];
    for (const [mode, impl] of [['user', this.userImpl], ['system', this.systemImpl]]) {
      const info = await impl.available();
      modes.push({ mode, label: impl.label, ...info });
    }
    return {
      current: this.mode,
      modes,
      needsPrivilege: this.impl().requiresPrivilege,
      privilege: this.privilege ? this.privilege.capabilities() : null,
    };
  }

  /**
   * Descobre em qual modo o túnel está instalado (pode estar no outro modo
   * por causa de versões anteriores do app ou do script bash).
   */
  async resolve(tunnel) {
    const current = this.impl();
    if (await current.detect(tunnel)) {
      return { mode: this.mode, impl: current };
    }
    const otherMode = this.mode === 'system' ? 'user' : 'system';
    const other = this.impl(otherMode);
    if (await other.detect(tunnel)) {
      return { mode: otherMode, impl: other };
    }
    return { mode: this.mode, impl: current };
  }

  async status(tunnel) {
    const { mode, impl } = await this.resolve(tunnel);
    const status = await impl.status(tunnel);
    return { ...status, mode };
  }

  async statusMany(tunnels) {
    const entries = await Promise.all(tunnels.map(async (tunnel) => {
      const status = await this.status(tunnel);
      return [tunnel, status];
    }));
    return Object.fromEntries(entries);
  }

  async enable(tunnel, options) {
    // Evita duas unidades para o mesmo túnel (uma em cada modo), o que faria
    // o cloudflared conectar duas vezes ao mesmo tunnel.
    if (process.platform === 'linux') {
      const otherMode = this.mode === 'system' ? 'user' : 'system';
      const other = this.impl(otherMode);
      if (await other.detect(tunnel)) {
        const otherStatus = await other.status(tunnel);
        return {
          ok: false,
          conflict: true,
          error: `Já existe uma unidade no modo "${otherMode}" (${otherStatus.detail}). `
            + `Remova-a em Serviço & Logs → Remover unidade antes de criar a unidade no modo "${this.mode}".`,
        };
      }
    }
    return this.impl().enable(tunnel, options);
  }

  /**
   * "Iniciar" no dashboard: cria a unidade se ainda não existir (sem ligar
   * autostart) e sobe o serviço. Autostart é ação separada (enable).
   */
  async startOrInstall(tunnel, options = {}) {
    const { impl, mode } = await this.resolve(tunnel);
    const status = await impl.status(tunnel);
    if (!status.installed) {
      const installed = await impl.install(tunnel, options);
      if (installed && installed.ok === false) return { ...installed, mode };
    }
    const started = await impl.start(tunnel);
    return { ...started, mode, installedNow: !status.installed };
  }

  async disable(tunnel) {
    const { impl } = await this.resolve(tunnel);
    return impl.disable(tunnel);
  }

  async start(tunnel) {
    const { impl } = await this.resolve(tunnel);
    return impl.start(tunnel);
  }

  async stop(tunnel) {
    const { impl } = await this.resolve(tunnel);
    return impl.stop(tunnel);
  }

  async restart(tunnel) {
    const { impl } = await this.resolve(tunnel);
    return impl.restart(tunnel);
  }

  async removeUnit(tunnel) {
    const { impl } = await this.resolve(tunnel);
    return impl.removeUnit(tunnel);
  }

  async logs(tunnel, options = {}) {
    const { impl } = await this.resolve(tunnel);
    const { cmd, args } = impl.logCommand(tunnel, options);
    const res = await run(cmd, args, { timeout: 30000 });
    const output = res.stdout || res.stderr || '';
    const needsPrivilege = /not seeing messages|No journal files|Access denied|permission/i.test(output);
    return {
      ok: true,
      logs: output || 'Sem entradas de log para este túnel.',
      needsPrivilege,
      command: `${cmd} ${args.join(' ')}`,
    };
  }

  logCommand(tunnel, options = {}) {
    const impl = this.impl();
    return impl.logCommand(tunnel, options);
  }

  async listManaged() {
    const userList = await this.userImpl.listManaged();
    if (process.platform !== 'linux') return userList;
    const systemList = await this.systemImpl.listManaged();
    return [...new Set([...userList, ...systemList])];
  }

  /** Para o "desinstalar": derruba tudo que este app criou. */
  async removeAll() {
    const removed = [];
    const managed = await this.listManaged().catch(() => []);
    for (const tunnel of managed) {
      const status = await this.status(tunnel).catch(() => null);
      if (status && status.installed) {
        const res = await this.removeUnit(tunnel).catch(() => ({ ok: false }));
        removed.push({ tunnel, ok: Boolean(res && res.ok) });
      }
    }
    if (process.platform === 'linux' && this.systemImpl.removeTemplate) {
      await this.systemImpl.removeTemplate().catch(() => {});
    }
    return removed;
  }
}

module.exports = {
  ServiceManager,
  SystemdUserService,
  SystemdSystemService,
  LaunchdService,
  WindowsService,
  SYSTEM_TEMPLATE,
  systemdUnitContent,
};
