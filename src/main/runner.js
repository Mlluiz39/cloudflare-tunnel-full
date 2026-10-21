'use strict';

const { spawn } = require('child_process');

const MAX_LINES = 800;
const MAX_BYTES = 256 * 1024;

/**
 * Gerencia processos filhos de longa duração (execução manual do túnel e
 * acompanhamento de logs), mantendo um buffer circular por tarefa.
 */
class TaskRunner {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.tasks = new Map();
  }

  has(id) {
    return this.tasks.has(id);
  }

  list() {
    return [...this.tasks.entries()].map(([id, task]) => ({
      id,
      kind: task.kind,
      meta: task.meta,
      startedAt: task.startedAt,
      pid: task.child.pid,
    }));
  }

  buffer(id) {
    const task = this.tasks.get(id);
    return task ? task.lines.join('\n') : '';
  }

  _append(task, text) {
    task.lines.push(...text.split(/\r?\n/).filter((line) => line !== ''));
    if (task.lines.length > MAX_LINES) {
      task.lines.splice(0, task.lines.length - MAX_LINES);
    }
    let bytes = 0;
    for (let i = task.lines.length - 1; i >= 0; i -= 1) {
      bytes += task.lines[i].length + 1;
      if (bytes > MAX_BYTES) {
        task.lines.splice(0, i + 1);
        break;
      }
    }
    this.onEvent('task:output', { id: task.id, text });
  }

  /**
   * Inicia uma tarefa. Se já existir uma com o mesmo id, devolve erro para
   * não duplicar processos.
   */
  start({ id, cmd, args = [], kind = 'process', meta = {}, env = {}, cwd = null }) {
    if (this.tasks.has(id)) {
      return { ok: false, error: 'Esta tarefa já está em execução.' };
    }

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }

    const task = {
      id,
      kind,
      meta,
      child,
      lines: [],
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      state: 'running',
      error: null,
    };
    this.tasks.set(id, task);

    const handleChunk = (chunk) => {
      this._append(task, chunk.toString());
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', (error) => {
      task.state = 'error';
      task.error = error.code === 'ENOENT'
        ? `Comando não encontrado: ${cmd}`
        : error.message;
      task.finishedAt = Date.now();
      this.onEvent('task:state', { id, state: 'error', error: task.error, meta });
    });

    child.on('close', (code, signal) => {
      task.exitCode = code;
      task.signal = signal || null;
      task.state = code === 0 ? 'exited' : 'failed';
      task.finishedAt = Date.now();
      this.onEvent('task:state', {
        id,
        state: task.state,
        code,
        signal: signal || null,
        meta,
      });
      // Mantém o buffer por um tempo para o renderer ler a saída final.
      setTimeout(() => {
        if (this.tasks.get(id) === task && task.state !== 'running') {
          this.tasks.delete(id);
        }
      }, 120000);
    });

    this.onEvent('task:state', { id, state: 'running', pid: child.pid, meta });
    return { ok: true, id, pid: child.pid };
  }

  stop(id, signal = 'SIGTERM') {
    const task = this.tasks.get(id);
    if (!task) return { ok: false, error: 'Tarefa não encontrada.' };
    try {
      task.child.kill(signal);
      task.state = 'stopping';
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  dispose(id) {
    this.tasks.delete(id);
    return { ok: true };
  }

  stopAll() {
    for (const id of [...this.tasks.keys()]) {
      this.stop(id);
    }
  }
}

module.exports = { TaskRunner };
