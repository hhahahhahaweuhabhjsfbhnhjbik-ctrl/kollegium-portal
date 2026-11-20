const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("portalSetup", {
  getState: () => ipcRenderer.invoke("setup:get-state"),
  save: (settings) => ipcRenderer.invoke("setup:save", settings)
});

contextBridge.exposeInMainWorld("portalDesktop", {
  openForum: () => ipcRenderer.invoke("portal:open-forum")
});
