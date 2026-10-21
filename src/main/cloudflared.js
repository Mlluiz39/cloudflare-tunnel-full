'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs').promises;
const https = require('https');
const os = require('os');
const path = require('path');

const {
  CONFIG_DIR,
  CERT_FILE,
  findInstalledBinary,
  configPathFor,
  credentialsPathFor,
  isValidName,
  isValidHostname,
  ensureConfigDir,
} = require('./paths');
const configTools = require('./config');
const { Privilege, commandExists } = require('./privilege');

const DEFAULT_TIMEOUT = 120000;
const MAX_BACKUPS = 5;

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

class CloudflaredAPI {
  /**
   * @param {object} options
   * @param {(channel: string, payload: any) => void} [options.onEvent]
   * @param {Privilege} [options.privilege]
   */
  constructor(options = {}) {
    this.onEvent = options.onEvent || (() => {});
    this.privilege = options.privilege || new Privilege();
    this.loginProcess = null;
  }

  emit(channel, payload) {
    try {
      this.onEvent(channel, payload);
    } catch {
      /* nunca deixa um listener quebrado derrubar o fluxo */
    }
  }

  getBinary() {
    return findInstalledBinary();
  }

  /** Executa o binário e sempre resolve (nunca rejeita). */
  exec(args, options = {}) {
    const {
      timeout = DEFAULT_TIMEOUT,
      env = {},
      input = null,
      cwd = CONFIG_DIR,
      binary = null,
    } = options;

    return new Promise((resolve) => {
      const bin = binary || this.getBinary();
      let child;
      try {
        child = spawn(bin, args, {
          cwd,
          env: { ...process.env, ...env },
          stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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

      if (input !== null && child.stdin) {
        child.stdin.end(input);
      }

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          error: error.code === 'ENOENT'
            ? `cloudflared não encontrado (${bin}). Instale em Configurações.`
            : error.message,
          code: error.code,
          stdout,
          stderr,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            ok: false,
            error: `Tempo esgotado após ${Math.round(timeout / 1000)}s.`,
            code: 'E_TIMEOUT',
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
          return;
        }
        const cleanOut = stdout.trim();
        const cleanErr = stderr.trim();
        if (code === 0) {
          resolve({ ok: true, stdout: cleanOut, stderr: cleanErr, code: 0 });
          return;
        }
        resolve({
          ok: false,
          code,
          error: (cleanErr || cleanOut || `cloudflared saiu com código ${code}`).trim(),
          stdout: cleanOut,
          stderr: cleanErr,
        });
      });
    });
  }

  // ---------------------------------------------------------------- versão

  async isInstalled() {
    const res = await this.exec(['--version'], { timeout: 15000 });
    return res.ok;
  }

  async version() {
    const res = await this.exec(['--version'], { timeout: 15000 });
    return res.ok ? res.stdout : null;
  }

  /** Informação consolidada usada pelo dashboard. */
  async status() {
    const binary = this.getBinary();
    const version = await this.version();
    return {
      installed: Boolean(version),
      binary,
      version,
      authenticated: this.hasCert(),
      configDir: CONFIG_DIR,
      certFile: CERT_FILE,
    };
  }

  hasCert() {
    try {
      return fs.statSync(CERT_FILE).isFile();
    } catch {
      return false;
    }
  }

  certMtime() {
    try {
      return fs.statSync(CERT_FILE).mtimeMs;
    } catch {
      return 0;
    }
  }

  // --------------------------------------------------------------- login

  /**
   * `cloudflared tunnel login`: abre o navegador e espera o cert.pem.
   * Aqui esperamos de verdade (o antigo só disparava e esquecia), para a
   * interface poder dizer "autenticado".
   */
  login({ timeout = 300000 } = {}) {
    if (this.loginProcess) {
      return Promise.resolve({ ok: false, error: 'Já existe um login em andamento.' });
    }

    return new Promise((resolve) => {
      const bin = this.getBinary();
      const before = this.certMtime();
      let child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      let poller = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(poller);
        clearTimeout(timer);
        this.loginProcess = null;
        resolve(result);
      };

      try {
        child = spawn(bin, ['tunnel', 'login'], {
          cwd: CONFIG_DIR,
          env: { ...process.env, BROWSER: process.env.BROWSER || '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }

      this.loginProcess = child;
      this.emit('cli:login:state', { state: 'waiting' });

      const collect = (chunk) => {
        const text = chunk.toString();
        stdout += text;
        this.emit('cli:login:output', { text });
        const match = /(https:\/\/dash\.cloudflare\.com\/[^\s"']+)/.exec(text);
        if (match) this.emit('cli:login:url', { url: match[1] });
      };

      child.stdout.on('data', collect);
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        collect(chunk);
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignora */ }
        finish({ ok: false, error: 'Login expirou. Tente novamente.' });
      }, timeout);

      // O cert.pem aparecer (ou ser reescrito) é o sinal real de sucesso.
      poller = setInterval(() => {
        if (this.certMtime() > before) {
          try { child.kill('SIGTERM'); } catch { /* ignora */ }
          finish({ ok: true, authenticated: true });
        }
      }, 1000);

      child.on('error', (error) => finish({ ok: false, error: error.message }));

      child.on('close', (code) => {
        if (this.certMtime() > before) {
          finish({ ok: true, authenticated: true });
          return;
        }
        finish({
          ok: false,
          code,
          error: (stderr || stdout || 'Login não concluído.').trim(),
        });
      });
    });
  }

  cancelLogin() {
    if (!this.loginProcess) return { ok: true };
    try { this.loginProcess.kill('SIGTERM'); } catch { /* ignora */ }
    this.loginProcess = null;
    this.emit('cli:login:state', { state: 'cancelled' });
    return { ok: true };
  }

  // ------------------------------------------------------------- túneis

  async listTunnels() {
    const res = await this.exec(['tunnel', 'list', '--output', 'json']);
    if (!res.ok) {
      return { ok: false, error: res.error, tunnels: [] };
    }
    try {
      const parsed = JSON.parse(res.stdout || '[]');
      const tunnels = (Array.isArray(parsed) ? parsed : []).map((tunnel) => ({
        id: tunnel.id,
        name: tunnel.name,
        createdAt: tunnel.created_at,
        connections: tunnel.connections || [],
        connsActive: (tunnel.conns_active || []).length,
      }));
      return { ok: true, tunnels };
    } catch (error) {
      return { ok: false, error: `Resposta inesperada do cloudflared: ${error.message}`, tunnels: [] };
    }
  }

  /** UUID lido da lista (igual ao script: nunca deduzido do nome). */
  async tunnelIdByName(name) {
    const res = await this.listTunnels();
    if (!res.ok) return null;
    const found = res.tunnels.find((tunnel) => tunnel.name === name);
    return found ? found.id : null;
  }

  /**
   * Cria o túnel e já deixa a configuração pronta (como a opção 3 do bash).
   * Verifica as credenciais, ajusta permissões e valida antes de assumir sucesso.
   */
  async createTunnel({ name, routes = [] }) {
    if (!isValidName(name)) {
      return { ok: false, error: 'Nome inválido. Use letras, números, _ e - (máx. 63).' };
    }

    const configPath = configPathFor(name);
    if (fs.existsSync(configPath)) {
      return { ok: false, error: `Já existe a configuração ${configPath}. Exclua ou renomeie antes.` };
    }

    const existing = await this.tunnelIdByName(name);
    if (existing) {
      return { ok: false, error: `Já existe um túnel chamado "${name}" nesta conta.` };
    }

    this.emit('task:progress', { task: 'create', message: `Criando túnel ${name}…` });
    const create = await this.exec(['tunnel', 'create', name]);
    if (!create.ok) {
      return { ok: false, error: create.error };
    }

    const id = await this.tunnelIdByName(name);
    if (!id) {
      return {
        ok: false,
        error: 'O túnel foi criado na Cloudflare, mas não apareceu em `tunnel list`. Recarregue o dashboard.',
      };
    }

    const credsPath = credentialsPathFor(id);
    if (!fs.existsSync(credsPath)) {
      return { ok: false, error: `Credenciais não encontradas: ${credsPath}` };
    }
    await fsp.chmod(credsPath, 0o600).catch(() => {});

    const text = configTools.buildConfigText({
      tunnelId: id,
      credentialsFile: credsPath,
      routes,
    });

    const saved = await this.saveConfig(name, text, { skipBackup: true });
    if (!saved.ok) {
      return {
        ok: false,
        error: `Túnel criado, mas a configuração não passou na validação: ${saved.error}`,
        tunnelId: id,
        configPath,
      };
    }

    await ensureConfigDir();
    this.emit('task:progress', { task: 'create', message: `Túnel ${name} pronto.` });
    return { ok: true, tunnelId: id, name, configPath, credentialsPath: credsPath };
  }

  /** Exclui o túnel remoto e limpa config/credenciais locais (opção 10). */
  async deleteTunnel({ id, name, removeFiles = true }) {
    if (!id) return { ok: false, error: 'UUID do túnel não informado.' };

    this.emit('task:progress', { task: 'delete', message: 'Encerrando conexões remotas…' });
    const cleanup = await this.exec(['tunnel', 'cleanup', id], { timeout: 60000 });

    const deletion = await this.exec(['tunnel', 'delete', id], { timeout: 60000 });
    if (!deletion.ok) {
      return {
        ok: false,
        error: `${deletion.error}${cleanup.ok ? '' : ` (cleanup: ${cleanup.error})`}`,
      };
    }

    const removed = [];
    if (removeFiles) {
      const files = [configPathFor(name), credentialsPathFor(id)];
      // Backups do editor também pertencem a este túnel: sem isso eles ficam
      // como lixo invisível em ~/.cloudflared.
      try {
        const backups = (await fsp.readdir(CONFIG_DIR))
          .filter((entry) => entry.startsWith(`${name}.yml.`) && entry.endsWith('.bak'))
          .map((entry) => path.join(CONFIG_DIR, entry));
        files.push(...backups);
      } catch {
        /* diretório ilegível: segue com os arquivos principais */
      }

      for (const file of files) {
        try {
          await fsp.rm(file, { force: true });
          removed.push(file);
        } catch {
          /* ignora */
        }
      }
    }

    return { ok: true, removed };
  }

  // -------------------------------------------------------- configuração

  async readConfig(name) {
    const configPath = configPathFor(name);
    try {
      const [content, stat] = await Promise.all([
        fsp.readFile(configPath, 'utf8'),
        fsp.stat(configPath),
      ]);
      return {
        ok: true,
        content,
        path: configPath,
        mtime: stat.mtimeMs,
        routes: configTools.listRoutes(content),
      };
    } catch (error) {
      return {
        ok: false,
        error: error.code === 'ENOENT'
          ? `Não existe ${configPath} para este túnel. Gere uma configuração nova.`
          : error.message,
        path: configPath,
      };
    }
  }

  /** Valida um texto de configuração sem tocar no arquivo real. */
  async validateText(text) {
    const structural = configTools.validateConfigText(text);
    if (!structural.ok) {
      return { ok: false, error: structural.problems.join('\n'), problems: structural.problems };
    }

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ctm-validate-'));
    const tempFile = path.join(dir, 'config.yml');
    try {
      await fsp.writeFile(tempFile, text, { mode: 0o600 });
      const res = await this.exec(['--config', tempFile, 'tunnel', 'ingress', 'validate'], {
        timeout: 30000,
      });
      return {
        ok: res.ok,
        error: res.ok ? null : res.error,
        output: res.ok ? res.stdout : res.stderr,
      };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Salva a configuração com segurança:
   *   1. valida o texto (estrutural + cloudflared) ANTES de gravar;
   *   2. cria backup do arquivo atual;
   *   3. troca de forma atômica;
   * Se a validação falhar, o arquivo antigo permanece intacto.
   */
  async saveConfig(name, content, { skipBackup = false } = {}) {
    const configPath = configPathFor(name);
    const validation = await this.validateText(content);
    if (!validation.ok) {
      return { ok: false, error: validation.error, notWritten: true };
    }

    let backupPath = null;
    if (!skipBackup) {
      try {
        const current = await fsp.readFile(configPath, 'utf8');
        backupPath = `${configPath}.${timestamp()}.bak`;
        await fsp.writeFile(backupPath, current, { mode: 0o600 });
        await this.pruneBackups(name);
      } catch {
        /* arquivo ainda não existe: sem backup */
      }
    }

    const tempFile = `${configPath}.${timestamp()}.tmp`;
    await fsp.writeFile(tempFile, content, { mode: 0o600 });
    await fsp.rename(tempFile, configPath);
    await fsp.chmod(configPath, 0o600).catch(() => {});

    return { ok: true, path: configPath, backupPath, routes: configTools.listRoutes(content) };
  }

  async pruneBackups(name) {
    const dir = CONFIG_DIR;
    const prefix = `${name}.yml.`;
    try {
      const entries = (await fsp.readdir(dir))
        .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.bak'))
        .sort();
      const excess = entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS));
      for (const entry of excess) {
        await fsp.rm(path.join(dir, entry), { force: true }).catch(() => {});
      }
    } catch {
      /* ignora */
    }
  }

  async listBackups(name) {
    const prefix = `${name}.yml.`;
    try {
      const entries = await fsp.readdir(CONFIG_DIR);
      return entries
        .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.bak'))
        .sort()
        .reverse()
        .map((entry) => ({ file: path.join(CONFIG_DIR, entry), name: entry }));
    } catch {
      return [];
    }
  }

  async restoreBackup(name, backupFile) {
    try {
      const content = await fsp.readFile(backupFile, 'utf8');
      return await this.saveConfig(name, content);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** Valida o arquivo que está no disco (usado antes de subir o serviço). */
  async validateConfigFile(name) {
    const configPath = configPathFor(name);
    if (!fs.existsSync(configPath)) {
      return { ok: false, error: `Configuração ausente: ${configPath}` };
    }
    const res = await this.exec(['--config', configPath, 'tunnel', 'ingress', 'validate'], {
      timeout: 30000,
    });
    return { ok: res.ok, error: res.ok ? null : res.error, output: res.stdout };
  }

  /** Cria a configuração para um túnel que ainda não tem arquivo local. */
  async scaffoldConfig({ name, tunnelId, routes = [], overwrite = false }) {
    if (!isValidName(name)) return { ok: false, error: 'Nome de túnel inválido.' };

    const existing = configPathFor(name);
    if (!overwrite && fs.existsSync(existing)) {
      return {
        ok: false,
        exists: true,
        error: `Já existe ${existing}. Sobrescrever apagaria as rotas atuais.`,
      };
    }

    const id = tunnelId || (await this.tunnelIdByName(name));
    if (!id) return { ok: false, error: 'Não foi possível descobrir o UUID do túnel.' };

    const credsPath = credentialsPathFor(id);
    const text = configTools.buildConfigText({
      tunnelId: id,
      credentialsFile: credsPath,
      routes,
    });
    const saved = await this.saveConfig(name, text, { skipBackup: !overwrite });
    if (!saved.ok) return saved;
    return {
      ok: true,
      path: saved.path,
      hasCredentials: fs.existsSync(credsPath),
      credentialsPath: credsPath,
      content: text,
    };
  }

  // ---------------------------------------------------------------- DNS

  async routeDNS({ tunnel, hostname }) {
    if (!isValidHostname(hostname)) {
      return { ok: false, error: `Hostname inválido: ${hostname}` };
    }
    if (!isValidName(tunnel)) {
      return { ok: false, error: 'Túnel inválido.' };
    }
    const res = await this.exec(['tunnel', 'route', 'dns', tunnel, hostname], { timeout: 60000 });
    if (!res.ok) {
      const message = /already exists|record with that host already exists/i.test(res.error)
        ? `Já existe um registro DNS para ${hostname}.`
        : res.error;
      return { ok: false, error: message };
    }
    return { ok: true, output: res.stdout || res.stderr };
  }

  // ----------------------------------------------------- instalar/atualizar

  async install() {
    const platform = process.platform;
    try {
      if (platform === 'linux') return await this.installLinux();
      if (platform === 'darwin') return await this.installMac();
      if (platform === 'win32') return await this.installWindows();
      return { ok: false, error: `SO não suportado: ${platform}` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async downloadFile(url, destination, { redirects = 6 } = {}) {
    this.emit('cli:install:progress', { phase: 'download', message: `Baixando ${path.basename(destination)}…` });

    const fetchInto = (currentUrl, redirectCount) => new Promise((resolve, reject) => {
      const request = https.get(currentUrl, {
        headers: { 'User-Agent': 'cloudflare-tunnel-manager' },
        timeout: 60000,
      }, (response) => {
        const { statusCode, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          if (redirectCount <= 0) {
            reject(new Error('Muitos redirecionamentos no download.'));
            return;
          }
          resolve(fetchInto(new URL(headers.location, currentUrl).toString(), redirectCount - 1));
          return;
        }
        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Download falhou (HTTP ${statusCode}) em ${currentUrl}`));
          return;
        }

        const total = Number.parseInt(headers['content-length'] || '0', 10);
        let received = 0;
        let lastEmit = 0;
        let tempPath = destination;
        try {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
        } catch {
          /* ignora */
        }
        tempPath = `${destination}.part`;
        const file = fs.createWriteStream(tempPath);

        response.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 300) {
            lastEmit = now;
            this.emit('cli:install:progress', {
              phase: 'download',
              received,
              total,
              percent: total ? Math.round((received / total) * 100) : null,
            });
          }
        });

        response.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              fs.renameSync(tempPath, destination);
              resolve(destination);
            } catch (error) {
              reject(error);
            }
          });
        });
        file.on('error', (error) => {
          try { fs.rmSync(tempPath, { force: true }); } catch { /* ignora */ }
          reject(error);
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error('Tempo esgotado no download.'));
      });
      request.on('error', (error) => {
        try { fs.rmSync(`${destination}.part`, { force: true }); } catch { /* ignora */ }
        reject(error);
      });
    });

    return fetchInto(url, redirects);
  }

  async installLinux() {
    const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
    if (!arch) return { ok: false, error: `Arquitetura não suportada: ${process.arch}` };

    const packageName = `cloudflared-linux-${arch}.deb`;
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${packageName}`;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ctm-deb-'));
    const debPath = path.join(tempDir, packageName);

    try {
      await this.downloadFile(url, debPath);
    } catch (error) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: `Falha no download: ${error.message}` };
    }

    this.emit('cli:install:progress', { phase: 'install', message: 'Instalando pacote (pede permissão)…' });

    const hasApt = Boolean(commandExists('apt-get'));
    if (hasApt) {
      const install = await this.privilege.run('env', [
        'DEBIAN_FRONTEND=noninteractive',
        'apt-get',
        'install',
        '-y',
        debPath,
      ], { timeout: 300000 });

      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      if (install.ok) {
        const version = await this.version();
        this.emit('cli:install:progress', { phase: 'done', message: version || 'Instalado' });
        return { ok: true, version };
      }

      // Fallback: binário direto no ~/.local/bin
      const fallback = await this.installBinaryLocally(arch);
      if (fallback.ok) return fallback;
      return { ok: false, error: install.error };
    }

    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return this.installBinaryLocally(arch);
  }

  async installBinaryLocally(arch) {
    const target = path.join(os.homedir(), '.local', 'bin', 'cloudflared');
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
    try {
      await this.downloadFile(url, target);
      await fsp.chmod(target, 0o755);
      const res = await this.exec(['--version'], { binary: target, timeout: 15000 });
      if (!res.ok) return { ok: false, error: `Binário baixado não executou: ${res.error}` };
      return { ok: true, version: res.stdout, binary: target };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async installMac() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    if (commandExists('brew')) {
      const install = await new Promise((resolve) => {
        const child = spawn('brew', ['install', 'cloudflared'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          this.emit('cli:install:progress', { phase: 'install', message: chunk.toString().trim() });
        });
        child.stderr.on('data', (chunk) => { output += chunk.toString(); });
        child.on('error', (error) => resolve({ ok: false, error: error.message }));
        child.on('close', (code) => resolve(code === 0
          ? { ok: true }
          : { ok: false, error: output.trim() || `brew falhou (${code})` }));
      });
      if (install.ok) return { ok: true, version: await this.version() };
    }

    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ctm-mac-'));
    const tgz = path.join(tempDir, 'cloudflared.tgz');
    try {
      await this.downloadFile(url, tgz);
      const extract = await this.exec(['-xzf', tgz, '-C', tempDir], { binary: 'tar', timeout: 60000 });
      if (!extract.ok) return { ok: false, error: extract.error };
      const binary = path.join(tempDir, 'cloudflared');
      await fsp.chmod(binary, 0o755);
      const destination = path.join(os.homedir(), '.cloudflared', 'cloudflared');
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(binary, destination);
      await fsp.chmod(destination, 0o755);
      return { ok: true, version: await this.version(), binary: destination };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async installWindows() {
    const arch = process.arch === 'x64' ? 'amd64' : '386';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`;
    const target = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'cloudflared',
      'cloudflared.exe',
    );
    try {
      await this.downloadFile(url, target);
      return { ok: true, binary: target, version: await this.version() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** Desinstala o pacote/binary preservando ~/.cloudflared (opção 11). */
  async uninstall() {
    const platform = process.platform;
    try {
      if (platform === 'linux') {
        if (!commandExists('apt-get')) {
          return { ok: false, error: 'apt-get não encontrado para remover o pacote.' };
        }
        const res = await this.privilege.run('env', [
          'DEBIAN_FRONTEND=noninteractive',
          'apt-get',
          'remove',
          '-y',
          'cloudflared',
        ], { timeout: 180000 });
        return res.ok
          ? { ok: true }
          : { ok: false, error: res.error };
      }
      if (platform === 'darwin') {
        if (commandExists('brew')) {
          const res = await this.exec(['uninstall', 'cloudflared'], { binary: 'brew', timeout: 120000 });
          if (res.ok) return { ok: true };
        }
        return { ok: true, note: 'Remova manualmente /usr/local/bin/cloudflared se existir.' };
      }
      if (platform === 'win32') {
        const target = path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
          'cloudflared',
          'cloudflared.exe',
        );
        await fsp.rm(target, { force: true });
        return { ok: true };
      }
      return { ok: false, error: `SO não suportado: ${platform}` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // ------------------------------------------------------------- backup

  defaultBackupPath() {
    const dir = path.join(os.homedir(), 'cloudflared-backups');
    return { dir, file: path.join(dir, `cloudflared-${timestamp()}.tar.gz`) };
  }

  async createBackup({ destination = null } = {}) {
    const target = destination || this.defaultBackupPath().file;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.chmod(path.dirname(target), 0o700).catch(() => {});
    } catch {
      /* ignora */
    }

    const parent = path.dirname(CONFIG_DIR);
    const base = path.basename(CONFIG_DIR);

    if (process.platform === 'win32') {
      const psTarget = target.replace(/'/g, "''");
      const psSource = CONFIG_DIR.replace(/'/g, "''");
      const res = await this.exec([
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${psSource}' -DestinationPath '${psTarget}' -Force`,
      ], { binary: 'powershell', timeout: 120000 });
      if (!res.ok) return { ok: false, error: res.error };
    } else {
      const res = await this.exec(['-czf', target, '-C', parent, base], {
        binary: 'tar',
        timeout: 120000,
      });
      if (!res.ok) return { ok: false, error: res.error };
    }

    try {
      await fsp.chmod(target, 0o600);
    } catch {
      /* ignora */
    }

    const stat = await fsp.stat(target).catch(() => null);
    return {
      ok: true,
      path: target,
      size: stat ? stat.size : null,
      warning: 'O backup contém credenciais secretas. Guarde-o criptografado.',
    };
  }
}

module.exports = { CloudflaredAPI, timestamp };
