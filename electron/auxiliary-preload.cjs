const { contextBridge, ipcRenderer } = require('electron')
const sends = new Set(['tray:command', 'desktop-lyrics:drag:start', 'desktop-lyrics:drag:move', 'desktop-lyrics:drag:end', 'desktop-lyrics:resize:start', 'desktop-lyrics:resize:move', 'desktop-lyrics:resize:end', 'desktop-lyrics:adjust-font', 'desktop-lyrics:set-lock', 'desktop-lyrics:hover', 'desktop-lyrics:reset', 'desktop-lyrics:close', 'video-window:drag:start', 'video-window:drag:move', 'video-window:drag:end', 'video-window:close', 'video-window:minimize', 'video-window:restore', 'video-window:prev', 'video-window:toggle', 'video-window:next', 'video-window:picture-failed'])
const events = new Set(['tray:state', 'desktop-lyrics:state', 'desktop-lyrics:drag:ended', 'desktop-lyrics:resize:ended', 'video-window:state'])
contextBridge.exposeInMainWorld('auxiliaryIPC', {
  send(channel, ...args) { if (sends.has(channel)) ipcRenderer.send(channel, ...args) },
  invoke(channel) { return channel === 'tray:get-state' ? ipcRenderer.invoke(channel) : Promise.reject(new Error('Unsupported channel')) },
  on(channel, callback) {
    if (!events.has(channel) || typeof callback !== 'function') return
    const handler = (_event, payload) => callback(null, payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
})
