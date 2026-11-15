'use strict';

// The renderer gets folder browsing from the main process; nothing else from
// Node crosses the bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SlamdanceNative', {
  start: () => ipcRenderer.invoke('sd:start'),
  browse: (dir) => ipcRenderer.invoke('sd:browse', dir),
  scan: (dir) => ipcRenderer.invoke('sd:scan', dir),
  read: (file) => ipcRenderer.invoke('sd:read', file),
});
