import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'fs'
import path from 'path'

const WIDTH = 420
const HEIGHT = 268
const BOUNDS_NAME = 'video-window-bounds.json'

interface VideoWindowState {
  visible: boolean
  url: string
  title: string
  paused: boolean
  time: number
  note: string
  quality: string
}

const emptyState = (): VideoWindowState => ({
  visible: false,
  url: '',
  title: '',
  paused: true,
  time: 0,
  note: '',
  quality: '',
})

function secureVideoHtml(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'")
    .join(' ')
  const policy = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; media-src https:; base-uri 'none'; form-action 'none'`
  return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`)
}

function videoHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #111; color: #f3f3f3; font-family: "Segoe UI", sans-serif; overflow: hidden; user-select: none; }
  video { display: block; width: 100%; height: calc(100% - 32px); background: #000; object-fit: contain; cursor: grab; }
  #bar { height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 12px; background: #1c1c1f; cursor: grab; }
  #bar.dragging { cursor: grabbing; }
  #title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  #quality { flex: 0 0 auto; font-size: 11px; color: #ff8cab; }
  #close, .jump { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: #f3f3f3; cursor: pointer; font-size: 14px; }
  #note { position: absolute; left: 16px; right: 16px; top: 40%; margin: 0; text-align: center; color: #c8c8c8; font-size: 13px; }
</style>
</head>
<body>
<video id="video" muted playsinline preload="auto"></video>
<p id="note" hidden></p>
<div id="bar"><button id="prev" class="jump" type="button" aria-label="上一首">⏮</button><button id="pause" class="jump" type="button" aria-label="暂停">❚❚</button><button id="next" class="jump" type="button" aria-label="下一首">⏭</button><span id="title">小窗</span><span id="quality"></span><button id="close" type="button" aria-label="关闭小窗">×</button></div>
<script>
  const ipc = window.auxiliaryIPC
  const video = document.getElementById('video')
  const title = document.getElementById('title')
  const qualityLabel = document.getElementById('quality')
  const note = document.getElementById('note')
  const bar = document.getElementById('bar')
  let current = ''
  let targetTime = 0
  let targetAt = 0
  let wantPlay = false
  let snapped = false
  let snapping = false
  let lastSeek = 0
  let dragging = false
  let pointerId = -1
  let heartbeat = null
  function liveTarget() {
    if (!wantPlay) return targetTime
    return targetTime + Math.max(0, (Date.now() - targetAt) / 1000)
  }
  function armPlayback() {
    if (!current || snapped) return
    snapped = true
    video.playbackRate = 1
    if (wantPlay) video.play().catch(() => {})
    else video.pause()
  }
  video.addEventListener('canplay', () => {
    if (!current || snapped || snapping || video.readyState < 2) return
    const drift = Math.abs(video.currentTime - liveTarget())
    if (drift > 0.12) {
      snapping = true
      video.currentTime = Math.max(0, liveTarget())
      return
    }
    armPlayback()
  })
  video.addEventListener('seeked', () => {
    if (!current || snapped) return
    snapping = false
    armPlayback()
  })
  setInterval(() => {
    if (!snapped || !current || video.seeking || snapping || video.readyState < 2) return
    const drift = video.currentTime - liveTarget()
    const abs = Math.abs(drift)
    const now = Date.now()
    if (abs > 0.42 && now - lastSeek > 1200) {
      lastSeek = now
      video.playbackRate = 1
      video.currentTime = Math.max(0, liveTarget())
      return
    }
    if (abs > 0.28) video.playbackRate = drift > 0 ? 0.9 : 1.1
    else if (abs > 0.08) video.playbackRate = drift > 0 ? 0.96 : 1.045
    else video.playbackRate = 1
  }, 240)
  function endDrag() {
    if (!dragging) return
    dragging = false
    bar.classList.remove('dragging')
    clearInterval(heartbeat)
    heartbeat = null
    try { if (pointerId >= 0) document.body.releasePointerCapture(pointerId) } catch (error) {}
    pointerId = -1
    ipc.send('video-window:drag:end')
  }
  const pauseButton = document.getElementById('pause')
  function paintPause() {
    pauseButton.textContent = wantPlay ? '❚❚' : '▶'
    pauseButton.setAttribute('aria-label', wantPlay ? '暂停' : '播放')
  }
  document.getElementById('prev').addEventListener('click', () => ipc.send('video-window:prev'))
  pauseButton.addEventListener('click', () => ipc.send('video-window:toggle'))
  document.getElementById('next').addEventListener('click', () => ipc.send('video-window:next'))
  let stallSince = 0
  let lastPictureTime = -1
  let stallReloads = 0
  let pinnedNote = ''
  setInterval(() => {
    if (pinnedNote || !current || !wantPlay) {
      stallSince = 0
      stallReloads = 0
      if (!pinnedNote && !wantPlay && note.textContent.indexOf('画面') === 0) note.hidden = true
      return
    }
    const pictureTime = video.currentTime || 0
    const stuck = video.readyState < 3 || Math.abs(pictureTime - lastPictureTime) < 0.04
    if (!stuck) {
      stallSince = 0
      stallReloads = 0
      lastPictureTime = pictureTime
      if (note.textContent.indexOf('画面') === 0 && !note.hidden) note.hidden = true
      return
    }
    if (!stallSince) stallSince = Date.now()
    if (Date.now() - stallSince < 2200) return
    note.hidden = false
    note.textContent = stallReloads ? '画面还是卡住了，可以关掉小窗再打开' : '画面加载中…'
    if (!stallReloads && Date.now() - stallSince > 3800) {
      stallReloads = 1
      snapped = false
      const src = current
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.src = src
    }
  }, 500)
  function beginDrag(event) {
    if (event.button !== 0) return
    if (event.target.closest && event.target.closest('button')) return
    const edge = 14
    if (event.clientX < edge || event.clientY < edge || event.clientX > window.innerWidth - edge || event.clientY > window.innerHeight - edge) return
    dragging = true
    pointerId = event.pointerId
    bar.classList.add('dragging')
    try { document.body.setPointerCapture(pointerId) } catch (error) {}
    ipc.send('video-window:drag:start')
    heartbeat = setInterval(() => ipc.send('video-window:drag:move'), 80)
    event.preventDefault()
  }
  document.body.addEventListener('pointerdown', beginDrag)
  window.addEventListener('pointermove', () => { if (dragging) ipc.send('video-window:drag:move') })
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
  document.getElementById('close').addEventListener('click', () => ipc.send('video-window:close'))
  let pictureReported = false
  video.addEventListener('error', () => {
    if (!current) return
    note.hidden = false
    note.textContent = '画面暂时打不开'
    if (pictureReported) return
    pictureReported = true
    ipc.send('video-window:picture-failed')
  })
  video.addEventListener('playing', () => { pictureReported = false })
  ipc.on('video-window:state', (_error, state) => {
    if (!state) return
    title.textContent = state.title || '小窗'
    qualityLabel.textContent = state.quality || ''
    if (Number.isFinite(state.time)) {
      targetTime = Math.max(0, Number(state.time))
      targetAt = Date.now()
    }
    wantPlay = !state.paused
    paintPause()
    pinnedNote = typeof state.note === 'string' ? state.note : ''
    if (!state.url) {
      current = ''
      snapped = false
      video.pause()
      video.removeAttribute('src')
      video.load()
      note.hidden = !pinnedNote
      note.textContent = pinnedNote
      return
    }
    if (pinnedNote) {
      note.hidden = false
      note.textContent = pinnedNote
    } else if (!wantPlay || note.textContent.indexOf('画面') !== 0) {
      note.hidden = true
    }
    if (state.url !== current) {
      pictureReported = false
      if (!pinnedNote) note.hidden = true
      current = state.url
      snapped = false
      snapping = false
      lastSeek = 0
      video.pause()
      video.src = state.url
      return
    }
    if (!snapped) return
    if (!wantPlay) video.pause()
    else if (video.paused) video.play().catch(() => {})
  })
</script>
</body>
</html>`
}

function httpsUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

export function registerVideoWindow(options: { preload: string; mainWindow: () => BrowserWindow | null; onAbove?: () => void }) {
  let videoWindow: BrowserWindow | null = null
  let state = emptyState()
  let dragging = false
  let origin: { cursor: Electron.Point; bounds: Electron.Rectangle } | null = null
  let dragTimer: ReturnType<typeof setTimeout> | null = null

  const boundsFile = () => path.join(app.getPath('userData'), BOUNDS_NAME)

  function readBounds(): { x: number; y: number } | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'))
      if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return { x: parsed.x, y: parsed.y }
    } catch { /* first launch */ }
    return null
  }

  function saveBounds() {
    if (!videoWindow || videoWindow.isDestroyed()) return
    const bounds = videoWindow.getBounds()
    try { fs.writeFileSync(boundsFile(), JSON.stringify({ x: bounds.x, y: bounds.y })) } catch { /* ignore */ }
  }

  function clamp(x: number, y: number, width: number, height: number) {
    const area = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea
    return {
      x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width)),
      y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height)),
      width,
      height,
    }
  }

  function push() {
    if (!videoWindow || videoWindow.isDestroyed()) return
    videoWindow.webContents.send('video-window:state', state)
  }

  function create() {
    if (videoWindow && !videoWindow.isDestroyed()) return videoWindow
    videoWindow = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      minWidth: 280,
      minHeight: 190,
      show: false,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#111111',
      webPreferences: {
        preload: options.preload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    videoWindow.setAlwaysOnTop(true, 'floating')
    videoWindow.setAspectRatio(16 / 9, { width: 0, height: 32 })
    videoWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    videoWindow.webContents.on('will-navigate', event => event.preventDefault())
    videoWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(secureVideoHtml(videoHtml()))}`)
    videoWindow.once('ready-to-show', push)
    videoWindow.on('moved', saveBounds)
    videoWindow.on('resized', saveBounds)
    videoWindow.on('closed', () => { videoWindow = null })
    return videoWindow
  }

  function show() {
    const win = create()
    if (!win.isVisible()) {
      const saved = readBounds()
      const { workArea } = screen.getPrimaryDisplay()
      const x = saved?.x ?? workArea.x + workArea.width - WIDTH - 24
      const y = saved?.y ?? workArea.y + workArea.height - HEIGHT - 72
      win.setBounds(clamp(x, y, WIDTH, HEIGHT))
      win.showInactive()
    }
    push()
  }

  function endDrag() {
    if (!dragging) return
    dragging = false
    origin = null
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null }
    if (videoWindow && !videoWindow.isDestroyed()) {
      videoWindow.setResizable(true)
      videoWindow.setAspectRatio(16 / 9, { width: 0, height: 32 })
    }
    saveBounds()
  }

  function fromVideoWindow(event: IpcMainEvent): boolean {
    return Boolean(videoWindow && !videoWindow.isDestroyed() && event.sender === videoWindow.webContents)
  }

  function fromMainWindow(event: IpcMainEvent): boolean {
    const main = options.mainWindow()
    return Boolean(main && !main.isDestroyed() && event.sender === main.webContents)
  }

  ipcMain.on('video-window:set-state', (event, patch: Partial<VideoWindowState>) => {
    if (!fromMainWindow(event) || !patch || typeof patch !== 'object') return
    if (typeof patch.visible === 'boolean') state.visible = patch.visible
    if (typeof patch.url === 'string') state.url = httpsUrl(patch.url)
    if (typeof patch.title === 'string') state.title = patch.title.slice(0, 120)
    if (typeof patch.paused === 'boolean') state.paused = patch.paused
    if (typeof patch.time === 'number' && Number.isFinite(patch.time)) state.time = Math.max(0, patch.time)
    if (typeof patch.note === 'string') state.note = patch.note.slice(0, 80)
    if (typeof patch.quality === 'string') state.quality = patch.quality.slice(0, 24)
    if (!state.visible) {
      endDrag()
      videoWindow?.hide()
      return
    }
    show()
    options.onAbove?.()
  })

  function sendCommand(command: 'prev' | 'next' | 'toggle') {
    const main = options.mainWindow()
    if (main && !main.isDestroyed()) main.webContents.send('video-window:command', command)
  }
  ipcMain.on('video-window:prev', (event) => { if (fromVideoWindow(event)) sendCommand('prev') })
  ipcMain.on('video-window:toggle', (event) => { if (fromVideoWindow(event)) sendCommand('toggle') })
  ipcMain.on('video-window:picture-failed', (event) => {
    if (!fromVideoWindow(event)) return
    const main = options.mainWindow()
    if (main && !main.isDestroyed()) main.webContents.send('video-window:picture-failed')
  })
  ipcMain.on('video-window:next', (event) => { if (fromVideoWindow(event)) sendCommand('next') })

  ipcMain.on('video-window:close', (event) => {
    if (!fromVideoWindow(event)) return
    state = { ...state, visible: false }
    endDrag()
    videoWindow?.hide()
    const main = options.mainWindow()
    if (main && !main.isDestroyed()) main.webContents.send('video-window:closed')
  })

  ipcMain.on('video-window:drag:start', (event) => {
    if (!fromVideoWindow(event) || !videoWindow) return
    origin = { cursor: screen.getCursorScreenPoint(), bounds: videoWindow.getBounds() }
    dragging = true
    videoWindow.setResizable(false)
    if (dragTimer) clearTimeout(dragTimer)
    dragTimer = setTimeout(endDrag, 1000)
  })

  ipcMain.on('video-window:drag:move', (event) => {
    if (!fromVideoWindow(event) || !dragging || !origin || !videoWindow) return
    const cursor = screen.getCursorScreenPoint()
    const next = clamp(
      origin.bounds.x + cursor.x - origin.cursor.x,
      origin.bounds.y + cursor.y - origin.cursor.y,
      origin.bounds.width,
      origin.bounds.height,
    )
    videoWindow.setBounds({ x: next.x, y: next.y, width: origin.bounds.width, height: origin.bounds.height })
    options.onAbove?.()
    if (dragTimer) clearTimeout(dragTimer)
    dragTimer = setTimeout(endDrag, 1000)
  })

  ipcMain.on('video-window:drag:end', (event) => {
    if (fromVideoWindow(event)) endDrag()
  })
}
