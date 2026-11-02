import { useEffect, useRef, useState } from 'react'
import { readStoredItem, writeStoredItem } from '@/utils/persistentStorage'
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext'
import { useNowPlaying } from '@/contexts/NowPlayingContext'
import { useAppSettings } from '@/hooks/useAppSettings'
import { useLyrics } from '@/hooks/useLyrics'
import type { DesktopLyricsStyle } from '@/types/electron.d'
import type { LyricLine } from '@/services/lyrics'

export interface DesktopLyricsSettings {
  enabled: boolean
  locked: boolean
  /** 用户亲手锁定或解锁过。没有这个标记时按未锁定处理，避免默认穿透导致无法拖动。 */
  lockChosen: boolean
  style: DesktopLyricsStyle
}

export const DEFAULT_DESKTOP_LYRICS: DesktopLyricsSettings = {
  enabled: false,
  locked: false,
  lockChosen: false,
  style: {
    fontSize: 30,
    bold: true,
    color: '#ff375f',
    outline: true,
    outlineWidth: 2,
    outlineColor: 'rgba(0,0,0,.85)',
    showBg: false,
    bgColor: 'rgba(0,0,0,.35)',
    bgRadius: 12,
    shadow: true,
  },
}

const STORAGE_KEY = 'bilimusic_desktop_lyrics'

export function loadDesktopLyricsSettings(): DesktopLyricsSettings {
  try {
    const raw = readStoredItem(STORAGE_KEY)
    if (!raw) return DEFAULT_DESKTOP_LYRICS
    const parsed = JSON.parse(raw)
    return {
      enabled: Boolean(parsed.enabled),
      lockChosen: parsed.lockChosen === true,
      locked: parsed.lockChosen === true ? parsed.locked !== false : false,
      style: { ...DEFAULT_DESKTOP_LYRICS.style, ...(parsed.style || {}) },
    }
  } catch {
    return DEFAULT_DESKTOP_LYRICS
  }
}

export function saveDesktopLyricsSettings(s: DesktopLyricsSettings) {
  try {
    writeStoredItem(STORAGE_KEY, JSON.stringify(s))
    window.dispatchEvent(new CustomEvent('DESKTOP_LYRICS_CHANGED_EVENT'))
  } catch {
    // ignore quota errors
  }
}

function activeLineIndex(lines: LyricLine[], t: number): number {
  let lo = 0
  let hi = lines.length - 1
  let res = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= t) {
      res = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return res
}

/**
 * 桌面歌词桥：把当前曲目/进度/歌词推送到主进程的桌面歌词窗口。
 * 挂载在 App 顶层，始终活跃（enabled 时）。
 */
export function useDesktopLyricsBridge() {
  const player = usePlayer()
  const { progress } = usePlayerProgress()
  const { settings } = useAppSettings()
  const { expanded } = useNowPlaying()
  const track = player.currentTrack
  const [dl, setDl] = useState(loadDesktopLyricsSettings)
  useEffect(() => {
    const sync = () => setDl(loadDesktopLyricsSettings())
    window.addEventListener('DESKTOP_LYRICS_CHANGED_EVENT', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('DESKTOP_LYRICS_CHANGED_EVENT', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  useEffect(() => {
    const api = window.electronAPI?.desktopLyrics
    if (!api?.onAdjustFont) return
    return api.onAdjustFont((delta) => {
      const current = loadDesktopLyricsSettings()
      const fontSize = Math.min(72, Math.max(16, Math.round(current.style.fontSize + delta)))
      saveDesktopLyricsSettings({ ...current, style: { ...current.style, fontSize } })
    })
  }, [])
  useEffect(() => {
    const api = window.electronAPI?.desktopLyrics
    if (!api?.onLockChanged) return
    return api.onLockChanged((locked) => {
      const current = loadDesktopLyricsSettings()
      saveDesktopLyricsSettings({ ...current, locked, lockChosen: true })
    })
  }, [])
  useEffect(() => {
    const api = window.electronAPI?.desktopLyrics
    if (!api?.onClose) return
    return api.onClose(() => {
      const current = loadDesktopLyricsSettings()
      saveDesktopLyricsSettings({ ...current, enabled: false })
    })
  }, [])
  const lyrics = useLyrics(track, dl.enabled && settings.showLyrics !== false)
  const lastSentRef = useRef('')

  useEffect(() => {
    const api = window.electronAPI?.desktopLyrics
    if (!api) return
    if (!dl.enabled) {
      api.setState({ visible: false, hold: false })
      lastSentRef.current = ''
      return
    }

    const result = lyrics.result
    let line = ''
    let nextLine = ''
    if (result?.synced && result.lines.length) {
      const idx = activeLineIndex(result.lines, progress + (result.offset || 0))
      if (idx >= 0) line = result.lines[idx].text
      if (idx + 1 < result.lines.length) nextLine = result.lines[idx + 1].text
    } else if (result && !result.synced) {
      // 无同步歌词：滚动显示前几行文本（简单处理，显示第一行）
      line = result.lines[0]?.text || ''
    }
    if (!line && track) line = `${track.title}${track.artist ? ` · ${track.artist}` : ''}`

    // 节流：内容+样式都没变就不推送
    const sig = JSON.stringify([line, nextLine, dl.style, dl.locked, player.isPlaying, Boolean(track), expanded])
    if (sig === lastSentRef.current) return
    lastSentRef.current = sig

    api.setState({
      visible: true,
      hold: expanded,
      line,
      nextLine,
      isPlaying: player.isPlaying,
      hasTrack: Boolean(track),
      locked: dl.locked,
      style: dl.style,
    })
  }, [dl.enabled, dl.locked, dl.style, lyrics.result, progress, player.isPlaying, track, settings.showLyrics, expanded])
}
