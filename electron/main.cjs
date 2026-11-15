'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'ogg',
  'oga',
  'flac',
  'wav',
  'm4a',
  'aac',
  'opus',
  'webm',
  'mp4',
]);
const MAX_DEPTH = 24;

function isAudio(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase());
}

// Folder import for the desktop build: the app draws its own browser because
// GTK's folder chooser returns the highlighted folder, not the current one.
ipcMain.handle('sd:start', () => {
  try {
    return app.getPath('music');
  } catch (err) {
    return app.getPath('home');
  }
});

ipcMain.handle('sd:browse', async (_event, dir) => {
  const target = path.resolve(String(dir || app.getPath('home')));
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error(`That is not a folder: ${target}`);

  const entries = await fs.readdir(target, { withFileTypes: true });
  const dirs = [];
  let audio = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) dirs.push(entry.name);
    else if (entry.isFile() && isAudio(entry.name)) audio += 1;
  }
  dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, dirs, audio };
});

async function collect(dir, depth, found) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, depth + 1, found);
    } else if (entry.isFile() && isAudio(entry.name)) {
      try {
        const stat = await fs.stat(full);
        found.push({
          path: full,
          name: entry.name,
          size: stat.size,
          modified: Math.round(stat.mtimeMs),
        });
      } catch (err) {
        // Unreadable file: leave it out rather than failing the whole folder.
      }
    }
  }
}

ipcMain.handle('sd:scan', async (_event, dir) => {
  const found = [];
  await collect(path.resolve(String(dir)), 0, found);
  found.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return found;
});

ipcMain.handle('sd:read', async (_event, file) => {
  return fs.readFile(path.resolve(String(file)));
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 540,
    show: false,
    backgroundColor: '#0a0a0c',
    title: 'Slamdance Audio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Bandcamp links and other web links belong in the user's browser, not in
  // the player. Local navigation stays inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
