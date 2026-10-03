const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewerAPI', {
    onLoadScreenshot: (callback) => {
        ipcRenderer.on('load-screenshot', (event, data) => callback(data));
    },
    closeWindow: () => ipcRenderer.send('close-viewer-window'),
    minimizeWindow: () => ipcRenderer.send('minimize-viewer-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-viewer-window'),
    saveImage: (dataUrl) => ipcRenderer.send('save-screenshot-image', dataUrl),
    copyImage: (dataUrl) => ipcRenderer.send('copy-screenshot-image', dataUrl)
});
