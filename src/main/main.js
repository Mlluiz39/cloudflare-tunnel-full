'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, powerSaveBlocker, shell, dialog } = require('electron');
const path = require('path');

const { ensureConfigDir, iconPath } = require('./paths');
const { createContext } = require('./context');
const { registerIpc } = require('./ipc');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let sleepBlockerId = null;
let ctx = null;

function createWindow() {
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    title: 'Cloudflare Tunnel Manager',
    backgroundColor: '#0F172A',
    show: false,
    icon: icon ? nativeImage.createFromPath(icon) : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.argv.includes('--dev') || process.env.CTM_DEV === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Links externos vão para o navegador, nunca para dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function createTray() {
  const icon = iconPath();
  if (!icon) return;
  try {
    const image = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 });
    if (image.isEmpty()) return;
    tray = new Tray(image);
    tray.setToolTip('Cloudflare Tunnel Manager');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir painel', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
    tray.on('click', () => showWindow());
  } catch (error) {
    // Sem tray o app continua utilizável pela janela normal.
    console.warn('Tray indisponível:', error.message);
  }
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function emitToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ctm:event', { channel, payload });
  }
}

function preventSleep() {
  try {
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } catch {
    /* não é crítico */
  }
}

async function bootstrap() {
  await ensureConfigDir();

  const built = createContext({
    onEvent: emitToRenderer,
    settingsDir: app.getPath('userData'),
  });

  ctx = { ...built, getWindow: () => mainWindow };

  registerIpc(ctx);
  createWindow();
  createTray();
  preventSleep();

  app.on('activate', () => showWindow());
}

// ---------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.setAppUserModelId('com.mlluiz39.cloudflare-tunnel-manager');

  app.whenReady().then(bootstrap).catch((error) => {
    dialog.showErrorBox('Falha ao iniciar', error.stack || error.message);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  // A janela principal só é destruída no quit; o app vive na bandeja.
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (ctx && ctx.runner) ctx.runner.stopAll();
  if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) {
    powerSaveBlocker.stop(sleepBlockerId);
  }
});

process.on('uncaughtException', (error) => {
  console.error('Erro não tratado no processo principal:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Promise rejeitada sem tratamento:', reason);
});

module.exports = { showWindow };
