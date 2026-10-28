const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('noteDeck', {
    save: data => ipcRenderer.invoke('file:save', data),
    open: () => ipcRenderer.invoke('file:open'),
    exportNote: data => ipcRenderer.invoke('file:export', data),
    printNote: data => ipcRenderer.invoke('file:print', data),
    about: () => ipcRenderer.invoke('app:about'),
    quit: () => ipcRenderer.invoke('app:quit')
});
