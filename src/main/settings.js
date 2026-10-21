'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  /** 'user' = systemd --user | 'system' = /etc/systemd/system (como o bash). */
  serviceMode: process.platform === 'linux' ? 'user' : 'system',
  lastTunnel: null,
  logLines: 200,
  autoRefresh: true,
  askBeforeDelete: true,
};

/**
 * Persistência simples em JSON (sem dependência externa).
 * Grava de forma atômica para não corromper o arquivo em caso de crash.
 */
class Settings {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'settings.json');
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.values = { ...DEFAULTS, ...parsed };
      }
    } catch {
      /* primeira execução ou arquivo corrompido: usa defaults */
    }
    return this.values;
  }

  all() {
    return { ...this.values };
  }

  get(key) {
    return this.values[key];
  }

  set(patch) {
    this.values = { ...this.values, ...patch };
    this.save();
    return this.all();
  }

  save() {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.values, null, 2), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch {
      /* não deve derrubar o app */
    }
  }
}

module.exports = { Settings, DEFAULTS };
