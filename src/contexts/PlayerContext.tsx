import { shuffledFrom, reconcileShuffle, trackAfterRemoval, trackEndAction } from '@/utils/playQueue'
import { createContext, memo, useContext, useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react'
import type { Track, RepeatMode } from '@/types'
import { extractAudio } from '@/services/api'
import { pageCidOf } from '@/services/biliBatchSource'
import { getLocalAudio } from '@/services/downloadManager'
import { fadeVolume, waitForMetadata, startPlayback, rememberPosition, savedPosition } from '@/services/playback'
import { addRecentTrack, toggleFavoriteTrack, loadFavoriteTracks, loadAppSettings, loadPlaylists, getPlaylist, PLAYLISTS_CHANGED_EVENT } from '@/utils/storage'
import { readStoredItem, writeStoredItem } from '@/utils/persistentStorage'
import { useAppSettings } from '@/hooks/useAppSettings'

const DESKTOP_LYRICS_KEY = 'bilimusic_desktop_lyrics'
const VIDEO_WINDOW_KEY = 'bilimusic_video_window'
const DESKTOP_LYRICS_CHANGED_EVENT = 'DESKTOP_LYRICS_CHANGED_EVENT'
const VIDEO_WINDOW_CHANGED_EVENT = 'VIDEO_WINDOW_CHANGED_EVENT'

function readEnabled(raw: string | null): boolean {
  try { return JSON.parse(raw || '{}').enabled === true } catch { return false }
}

function toggleDesktopLyrics() {
  let current: Record<string, unknown> = {}
  try { current = JSON.parse(readStoredItem(DESKTOP_LYRICS_KEY) || '{}') } catch { current = {} }
  writeStoredItem(DESKTOP_LYRICS_KEY, JSON.stringify({ ...current, enabled: current.enabled !== true }))
  window.dispatchEvent(new CustomEvent(DESKTOP_LYRICS_CHANGED_EVENT))
}

function toggleVideoWindow() {
  const enabled = !readEnabled(localStorage.getItem(VIDEO_WINDOW_KEY))
  try { localStorage.setItem(VIDEO_WINDOW_KEY, JSON.stringify({ enabled })) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(VIDEO_WINDOW_CHANGED_EVENT))
}

interface PlayerState {
  currentTrack: Track | null
  isPlaying: boolean
  repeatMode: RepeatMode
  isShuffled: boolean
  queue: Track[]
  loadingAudio: boolean
  playbackSource: 'local' | 'online' | null
  /** 列表播完或被清空。和卡顿提示分开，避免小窗只是停在最后一帧。 */
  playbackNotice: string
  /** 当前队列是从哪个歌单开始播的。从搜索直接播放时可能没有。 */
  sourcePlaylistId?: string
}

interface VolumeState {
  volume: number
  isMuted: boolean
  setVolume: (v: number) => void
  setIsMuted: (m: boolean) => void
}

interface PlayerActions {
  play: (track: Track) => void
  pause: () => void
  togglePlay: () => void
  next: () => void
  prev: () => void
  setRepeatMode: (m: RepeatMode) => void
  setIsShuffled: (s: boolean) => void
  addToQueue: (track: Track) => void
  addTracksToQueue: (tracks: Track[]) => void
  removeFromQueue: (trackId: string) => void
  removeMultipleFromQueue: (trackIds: string[]) => void
  moveInQueue: (fromIndex: number, toIndex: number) => void
  playNow: (track: Track) => void
  playFromList: (track: Track, list: Track[], playlistId?: string) => void
  playNext: (track: Track) => void
  clearQueue: () => void
  toggleLike: (trackId: string) => void
  playAll: (tracks: Track[], playlistId?: string) => void
  playFromQueue: (index: number) => void
  showToast: (msg: string) => void
}

interface PlayerProgress {
  progress: number
  duration: number
  setProgress: (p: number) => void
}

type PlayerContext = PlayerState & PlayerActions

interface PersistedPlayerState {
  currentTrack: Track | null
  queue: Track[]
  progress: number
  duration: number
  volume: number
  isMuted: boolean
  repeatMode: RepeatMode
  isShuffled: boolean
  wasPlaying: boolean
  currentIndex: number
  sourcePlaylistId?: string
}

const PlayerContext = createContext<PlayerContext | null>(null)
const VolumeContext = createContext<VolumeState | null>(null)
const PlayerProgressContext = createContext<PlayerProgress | null>(null)
const PlayerTree = memo(function PlayerTree({ children }: { children: ReactNode }) {
  return children
})
const PLAYER_STATE_KEY = 'bilimusic_player_state'

function playbackFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  if (/412|429/.test(message)) return 'B 站限制了这次请求，过一会儿再点播放'
  if (/403|401/.test(message)) return '播放地址失效了，点击播放会重新获取'
  if (/没有可播放|没有音频|无音频/.test(message)) return '这条视频没有可播放的音频'
  if (!navigator.onLine || /Failed to fetch|NetworkError|ERR_/.test(message)) return '音频地址连不上。网页能打开，不代表这条音频地址还能用'
  return message ? `暂时无法播放：${message.slice(0, 72)}` : '暂时无法播放，点击播放会重新获取地址'
}

function playlistTracksFor(trackId: string, playlistId?: string): Track[] | null {
  const lists = loadPlaylists().filter(list => list.tracks.some(track => track.id === trackId))
  const chosen = (playlistId && lists.find(list => list.id === playlistId))
    || (lists.length === 1 ? lists[0] : [...lists].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0])
  return chosen && chosen.tracks.length ? chosen.tracks : null
}

function loadPersistedPlayerState(): PersistedPlayerState {
  const fallbackVolume = localStorage.getItem('bilimusic_volume')
  const fallback: PersistedPlayerState = {
    currentTrack: null,
    queue: [],
    progress: 0,
    duration: 0,
    volume: fallbackVolume ? parseInt(fallbackVolume) : 80,
    isMuted: false,
    repeatMode: 'none',
    isShuffled: false,
    wasPlaying: false,
    currentIndex: -1,
  }

  try {
    const raw = localStorage.getItem(PLAYER_STATE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedPlayerState>
    const savedQueue = Array.isArray(parsed.queue) ? parsed.queue : []
    const track = parsed.currentTrack?.id ? parsed.currentTrack : null
    const fromPlaylist = track ? playlistTracksFor(track.id, parsed.sourcePlaylistId) : null
    const queue = fromPlaylist || savedQueue
    const restoredIndex = track ? queue.findIndex(item => item.id === track.id) : -1
    const autoplay = loadAppSettings().resumeOnLaunch === true && Boolean(track)
    return {
      ...fallback,
      ...parsed,
      currentTrack: track,
      wasPlaying: autoplay,
      sourcePlaylistId: parsed.sourcePlaylistId,
      queue,
      progress: Math.max(0, Number(parsed.progress || 0)),
      duration: Math.max(0, Number(parsed.duration || 0)),
      volume: Math.min(100, Math.max(0, Number(parsed.volume ?? fallback.volume))),
      currentIndex: restoredIndex,
      repeatMode: parsed.repeatMode === 'one' || parsed.repeatMode === 'all' ? parsed.repeatMode : 'none',
    }
  } catch {
    return fallback
  }
}

function shouldIgnoreSpaceShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tagName = target.tagName.toLowerCase()
  if (['input', 'textarea', 'select', 'button'].includes(tagName)) return true
  const role = target.getAttribute('role')
  return Boolean(role && ['button', 'textbox', 'searchbox', 'slider', 'switch', 'combobox'].includes(role))
}

function getArtworkType(url: string): string | undefined {
  if (/\.webp($|\?)/i.test(url)) return 'image/webp'
  if (/\.png($|\?)/i.test(url)) return 'image/png'
  if (/\.(jpe?g)($|\?)/i.test(url)) return 'image/jpeg'
  return undefined
}

function setMediaSessionAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
  try {
    navigator.mediaSession.setActionHandler(action, handler)
  } catch {
    // Some Chromium/Electron platform builds expose only part of the action set.
  }
}

function clearMediaSessionActions(actions: MediaSessionAction[]): void {
  actions.forEach(action => setMediaSessionAction(action, null))
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { settings } = useAppSettings()
  const [initialState] = useState(loadPersistedPlayerState)
  const restoredRef = useRef(initialState)
  const sourcePlaylistIdRef = useRef(initialState.sourcePlaylistId)
  const [sourcePlaylistId, setSourcePlaylistId] = useState(initialState.sourcePlaylistId)
  const currentTrackRef = useRef<Track | null>(restoredRef.current.currentTrack)
  const persistEnabledRef = useRef(true)
  const [loadVersion, setLoadVersion] = useState(0)
  const [currentTrack, setCurrentTrack] = useState<Track | null>(() => restoredRef.current.currentTrack)
  const [isPlaying, setIsPlaying] = useState(() => Boolean(restoredRef.current.currentTrack && restoredRef.current.wasPlaying))
  const [progress, setProgress] = useState(() => restoredRef.current.progress)
  const [duration, setDuration] = useState(() => restoredRef.current.duration)
  const [volume, setVolumeState] = useState(() => restoredRef.current.volume)
  const [isMuted, setIsMuted] = useState(() => restoredRef.current.isMuted)
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(() => restoredRef.current.repeatMode)
  const [isShuffled, setIsShuffled] = useState(() => restoredRef.current.isShuffled)
  const repeatModeRef = useRef(repeatMode)
  const isShuffledRef = useRef(isShuffled)
  repeatModeRef.current = repeatMode
  isShuffledRef.current = isShuffled
  const [queue, setQueue] = useState<Track[]>(() => restoredRef.current.queue)
  currentTrackRef.current = currentTrack
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const shuffledQueueRef = useRef<Track[]>([])
  const currentIndexRef = useRef(restoredRef.current.currentIndex)
  const shouldAutoplayRef = useRef(Boolean(restoredRef.current.currentTrack && restoredRef.current.wasPlaying))
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const progressRef = useRef(progress)
  const durationRef = useRef(duration)
  const targetVolumeRef = useRef(volume / 100)
  const loudnessGainRef = useRef(1)
  const playingIdRef = useRef<string | null>(null)
  const heardVolume = () => Math.min(1, Math.max(0, targetVolumeRef.current * loudnessGainRef.current))
  const isMutedRef = useRef(isMuted)
  const volumeFrameRef = useRef(0)
  isMutedRef.current = isMuted
  const seekVersionRef = useRef(0)
  const retryPlaybackRef = useRef<(() => void) | null>(null)
  const [playbackSource, setPlaybackSource] = useState<'local' | 'online' | null>(null)
  const [playbackNotice, setPlaybackNotice] = useState('')

  const alignLoudness = useCallback((url: string, trackId: string) => {
    const measure = window.electronAPI?.measureLoudness
    if (!measure || !url.startsWith('https://')) return
    void measure(url).then(gain => {
      if (!Number.isFinite(gain) || gain <= 0) return
      if (playingIdRef.current !== trackId) return
      loudnessGainRef.current = Math.min(4, Math.max(0.25, gain))
      const audio = audioRef.current
      if (audio && !isMutedRef.current && !audio.paused) void fadeVolume(audio, heardVolume(), 320)
    }).catch(() => {})
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2000)
  }, [])

  // 初始化 audio 元素
  useEffect(() => {
    const audio = new Audio()
    audio.volume = volume / 100
    audioRef.current = audio

    const onTimeUpdate = () => setProgress(audio.currentTime)
    const onDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    const onEnded = () => { /* handled in playTrack */ }
    const onPlaying = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onDuration)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('pause', onPause)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onDuration)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('pause', onPause)
      audio.pause()
      audio.src = ''
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.muted = isMuted
    if (!isMuted) audio.volume = heardVolume()
  }, [isMuted])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem('bilimusic_volume', String(volume)) } catch { /* storage full */ }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [volume])

  useEffect(() => {
    progressRef.current = progress
  }, [progress])

  useEffect(() => {
    durationRef.current = duration
  }, [duration])

  const handleTrackEnd = useCallback(() => {
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    const index = displayQueue.findIndex(track => track.id === currentTrack?.id)
    const action = trackEndAction(repeatMode, settings.autoPlay, displayQueue.length, index)
    if (action === 'stop') {
      shouldAutoplayRef.current = false
      audioRef.current?.pause()
      setIsPlaying(false)
      setPlaybackNotice('列表已播放完')
      showToast('列表已播放完')
      return
    }
    if (action === 'replay') {
      const audio = audioRef.current
      if (!audio || !currentTrack) return
      audio.currentTime = 0
      progressRef.current = 0
      setProgress(0)
      shouldAutoplayRef.current = true
      audio.volume = 0
      audio.play().then(() => {
        if (shouldAutoplayRef.current) void fadeVolume(audio, heardVolume())
      }).catch(() => retryPlaybackRef.current?.())
      return
    }
    // Loop the existing shuffled order: each track is visited once per cycle.
    currentIndexRef.current = action
    shouldAutoplayRef.current = true
    setLoadVersion(v => v + 1)
    setCurrentTrack(displayQueue[action])
    setProgress(0)
    setIsPlaying(true)
  }, [currentTrack, isShuffled, queue, repeatMode, settings.autoPlay, showToast])

  // One source lifecycle owns retries, listeners and cancellation, preventing late requests from stealing playback.
  useEffect(() => {
    const audio = audioRef.current
    if (!currentTrack || !audio) return
    const track = currentTrack
    const controller = new AbortController()
    let busy = false, attempts = 0, localSource = false, ready = false, failed = false
    let lastBookmark = 0
    let stalledTimer: ReturnType<typeof setTimeout> | undefined
    const firstRestore = restoredRef.current.currentTrack?.id === track.id
    const initialPosition = firstRestore ? restoredRef.current.progress : savedPosition(track.id)
    restoredRef.current.currentTrack = null
    const clearStall = () => { clearTimeout(stalledTimer); stalledTimer = undefined }
    const save = () => { if (ready) rememberPosition(track.id, audio.currentTime, audio.duration) }
    const onTime = () => {
      if (Date.now() - lastBookmark > 5000) { save(); lastBookmark = Date.now() }
      if (audio.readyState >= 3) clearStall()
    }
    async function load(position: number, forceOnline = false) {
      if (busy || controller.signal.aborted) return
      busy = true
      ready = false
      clearStall()
      setLoadingAudio(true)
      setPlaybackSource(null)
      loudnessGainRef.current = 1
      playingIdRef.current = track.id
      try {
        const fade = fadeVolume(audio!, 0, audio!.paused ? 1 : 150)
        const fallback = track.aid && track.cid ? { aid: track.aid, cid: track.cid } : undefined
        const resolved = (async () => {
          const local = !forceOnline ? await getLocalAudio(track) : null
          if (local) return { local: true as const, source: { audioUrl: local, duration: track.duration, coverUrl: track.coverUrl } }
          return { local: false as const, source: await extractAudio(track.bvid || track.id, fallback, pageCidOf(track)) }
        })()
        await fade
        if (controller.signal.aborted) return
        audio!.pause()
        const { local, source } = await resolved
        if (controller.signal.aborted) return
        localSource = Boolean(local)
        audio!.src = source.audioUrl
        audio!.load()
        await waitForMetadata(audio!, controller.signal)
        if (controller.signal.aborted) return
        const duration = Number.isFinite(audio!.duration) ? audio!.duration : source.duration
        audio!.currentTime = Math.max(0, Math.min(position, Math.max(0, duration - 0.5)))
        setProgress(audio!.currentTime)
        setDuration(duration)
        setPlaybackSource(localSource ? 'local' : 'online')
        ready = true
        if (shouldAutoplayRef.current) {
          await startPlayback(audio!, controller.signal)
          if (controller.signal.aborted) return
          await fadeVolume(audio!, heardVolume())
          void alignLoudness(source.audioUrl, track.id)
        }
        if (!controller.signal.aborted) {
          setCurrentTrack(prev => prev?.id === track.id ? { ...prev, coverUrl: source.coverUrl || track.coverUrl } : prev)
          addRecentTrack({ ...track, coverUrl: source.coverUrl || track.coverUrl })
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (attempts < 2 && !(error instanceof DOMException && error.name === 'NotAllowedError')) {
          attempts++
          busy = false
          await load(position, true)
          return
        }
        setIsPlaying(false)
        failed = true
        showToast(playbackFailureText(error))
      } finally {
        busy = false
        if (!controller.signal.aborted) setLoadingAudio(false)
      }
    }
    const recover = () => {
      if (busy || controller.signal.aborted) return
      save()
      if (attempts >= 2) { setLoadingAudio(false); setIsPlaying(false); audio.pause(); showToast('音频连接中断，点击播放重试'); return }
      attempts++
      void load(audio.currentTime || progressRef.current, localSource)
    }
    const onStall = () => {
      if (!shouldAutoplayRef.current || busy || stalledTimer) return
      stalledTimer = setTimeout(recover, 12000)
    }
    retryPlaybackRef.current = () => {
      attempts = 0
      const online = failed
      failed = false
      void load(audio.currentTime || progressRef.current, online)
    }
    audio.addEventListener('error', recover)
    audio.addEventListener('stalled', onStall)
    audio.addEventListener('waiting', onStall)
    audio.addEventListener('playing', clearStall)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('pause', save)
    audio.addEventListener('ended', save)
    window.addEventListener('beforeunload', save)
    void load(initialPosition)
    return () => {
      save(); controller.abort(); clearStall(); seekVersionRef.current++
      retryPlaybackRef.current = null
      audio.removeEventListener('error', recover)
      audio.removeEventListener('stalled', onStall)
      audio.removeEventListener('waiting', onStall)
      audio.removeEventListener('playing', clearStall)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('pause', save)
      audio.removeEventListener('ended', save)
      window.removeEventListener('beforeunload', save)
    }
  }, [currentTrack?.id, currentTrack?.bvid, loadVersion])

  // ended 事件
  useEffect(() => {
    if (!audioRef.current) return
    const handler = () => handleTrackEnd()
    audioRef.current.addEventListener('ended', handler)
    return () => audioRef.current?.removeEventListener('ended', handler)
  }, [handleTrackEnd])

  const play = useCallback((track: Track) => {
    setPlaybackNotice('')
    setLoadVersion(v => v + 1)
    shouldAutoplayRef.current = true
    setCurrentTrack(track)
    setProgress(0)
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    const idx = displayQueue.findIndex(t => t.id === track.id)
    currentIndexRef.current = idx >= 0 ? idx : 0
  }, [isShuffled, queue])

  const pause = useCallback(() => {
    shouldAutoplayRef.current = false
    audioRef.current?.pause()
    setIsPlaying(false)
  }, [])

  const togglePlay = useCallback(() => {
    if (!currentTrack) return
    if (isPlaying) {
      shouldAutoplayRef.current = false
      audioRef.current?.pause()
      setIsPlaying(false)
    } else {
      shouldAutoplayRef.current = true
      setPlaybackNotice('')
      const audio = audioRef.current
      if (!audio?.src || audio.error) { retryPlaybackRef.current?.(); return }
      audio.volume = 0
      audio.play().then(() => { if (shouldAutoplayRef.current) void fadeVolume(audio, heardVolume()) }).catch(() => retryPlaybackRef.current?.())
    }
  }, [currentTrack, isPlaying])

  const next = useCallback(() => {
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    if (displayQueue.length === 0) return
    setPlaybackNotice('')
    setLoadVersion(v => v + 1)
    const nextIdx = currentIndexRef.current + 1 >= displayQueue.length
      ? 0 : currentIndexRef.current + 1
    currentIndexRef.current = nextIdx
    shouldAutoplayRef.current = true
    setCurrentTrack(displayQueue[nextIdx])
    setProgress(0)
    setIsPlaying(true)
  }, [isShuffled, queue])

  const prev = useCallback(() => {
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    if (displayQueue.length === 0) return
    setPlaybackNotice('')
    setLoadVersion(v => v + 1)
    const prevIdx = currentIndexRef.current - 1 < 0
      ? displayQueue.length - 1 : currentIndexRef.current - 1
    currentIndexRef.current = prevIdx
    shouldAutoplayRef.current = true
    setCurrentTrack(displayQueue[prevIdx])
    setProgress(0)
    setIsPlaying(true)
  }, [isShuffled, queue])

  const handleSetProgress = useCallback((p: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(p) || audio.readyState < 1) return
    const position = Math.max(0, Math.min(p, durationRef.current || p))
    const version = ++seekVersionRef.current
    setProgress(position)
    void (async () => {
      if (!audio.paused) await fadeVolume(audio, 0)
      if (version !== seekVersionRef.current) return
      audio.currentTime = position
      await fadeVolume(audio, heardVolume())
    })()
  }, [])

  const handleSetVolume = useCallback((v: number) => {
    const next = Math.max(0, Math.min(100, Math.round(v)))
    targetVolumeRef.current = next / 100
    if (audioRef.current && !isMutedRef.current) audioRef.current.volume = heardVolume()
    if (volumeFrameRef.current) return
    volumeFrameRef.current = requestAnimationFrame(() => {
      volumeFrameRef.current = 0
      const latest = Math.round(targetVolumeRef.current * 100)
      setVolumeState(prev => prev === latest ? prev : latest)
    })
  }, [])

  const addToQueue = useCallback((track: Track) => {
    const exists = queue.some(t => t.id === track.id)
    setQueue(prev => {
      if (prev.some(t => t.id === track.id)) return prev
      const newQueue = [...prev, track]
      if (!currentTrack) {
        shouldAutoplayRef.current = true
        setCurrentTrack(track)
        currentIndexRef.current = 0
      }
      return newQueue
    })
    showToast(exists ? '已在播放列表中' : '已加入播放列表')
  }, [queue, currentTrack, showToast])

  const addTracksToQueue = useCallback((tracks: Track[]) => {
    setQueue(prev => {
      const existingIds = new Set(prev.map(t => t.id))
      const newTracks = tracks.filter(t => !existingIds.has(t.id))
      const newQueue = [...prev, ...newTracks]
      if (!currentTrack && newQueue.length > 0) {
        shouldAutoplayRef.current = true
        setCurrentTrack(newQueue[0])
        currentIndexRef.current = 0
      }
      return newQueue
    })
  }, [currentTrack])

  // 队列变更后把 currentIndexRef 重新对齐到当前曲目（避免 next/prev 错位）
  const resyncIndex = useCallback((nextQueue: Track[]) => {
    const curId = currentTrack?.id
    if (curId) currentIndexRef.current = nextQueue.findIndex(t => t.id === curId)
  }, [currentTrack])

  const removeFromQueue = useCallback((trackId: string) => {
    setQueue(prev => {
      const next = prev.filter(t => t.id !== trackId)
      resyncIndex(next)
      return next
    })
  }, [resyncIndex])

  const removeMultipleFromQueue = useCallback((trackIds: string[]) => {
    const idSet = new Set(trackIds)
    setQueue(prev => {
      const next = prev.filter(t => !idSet.has(t.id))
      resyncIndex(next)
      return next
    })
  }, [resyncIndex])

  // 调整顺序：把 fromIndex 的曲目移动到 toIndex
  const moveInQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue(prev => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 || fromIndex >= prev.length ||
        toIndex < 0 || toIndex >= prev.length
      ) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      resyncIndex(next)
      return next
    })
  }, [resyncIndex])

  // 立即播放：把曲目置于队列首位并播放（点击歌曲的默认行为）
  const playNow = useCallback((track: Track) => {
    setPlaybackNotice('')
    setLoadVersion(v => v + 1)
    shouldAutoplayRef.current = true
    setQueue(prev => [track, ...prev.filter(t => t.id !== track.id)])
    setCurrentTrack(track)
    setProgress(0)
    currentIndexRef.current = 0
    setIsPlaying(true)
  }, [])

  // 下一首播放：把曲目插入到当前曲目之后（不在队列则新增；无播放则等同立即播放）
  const playNext = useCallback((track: Track) => {
    if (!currentTrack) { playNow(track); return }
    setQueue(prev => {
      const without = prev.filter(t => t.id !== track.id)
      const curIdx = without.findIndex(t => t.id === currentTrack.id)
      const insertAt = curIdx >= 0 ? curIdx + 1 : without.length
      const next = [...without.slice(0, insertAt), track, ...without.slice(insertAt)]
      resyncIndex(next)
      return next
    })
    showToast('已设为下一首播放')
  }, [currentTrack, resyncIndex, showToast, playNow])

  const clearQueue = useCallback(() => {
    const hadPlayback = queue.length > 0 || Boolean(currentTrackRef.current)
    shouldAutoplayRef.current = false
    setQueue([])
    setCurrentTrack(null)
    setIsPlaying(false)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
    }
    if (hadPlayback) {
      setPlaybackNotice('播放列表已经空了')
      showToast('播放列表已经空了')
    }
  }, [queue.length, showToast])

  const toggleLike = useCallback((trackId: string) => {
    const track = queue.find(t => t.id === trackId) || currentTrack
    if (track) {
      toggleFavoriteTrack(track)
    }
    setCurrentTrack(prev => prev && prev.id === trackId ? { ...prev, isLiked: !prev.isLiked } : prev)
    setQueue(prev => prev.map(t => t.id === trackId ? { ...t, isLiked: !t.isLiked } : t))
  }, [queue, currentTrack])

  const playFromList = useCallback((track: Track, tracks: Track[], playlistId?: string) => {
    if (!tracks.some(item => item.id === track.id)) return
    setPlaybackNotice('')
    sourcePlaylistIdRef.current = playlistId
    setSourcePlaylistId(playlistId)
    const favIds = new Set(loadFavoriteTracks().map(item => item.id))
    const unique = [...new Map(tracks.map(item => [item.id, item])).values()]
    const synced = unique.map(item => ({ ...item, isLiked: favIds.has(item.id) }))
    const selected = synced.find(item => item.id === track.id)!
    shuffledQueueRef.current = isShuffled ? shuffledFrom(synced, selected.id) : []
    currentIndexRef.current = isShuffled ? 0 : synced.findIndex(item => item.id === selected.id)
    setQueue(synced)
    shouldAutoplayRef.current = true
    setLoadVersion(v => v + 1)
    setCurrentTrack(selected)
    setProgress(0)
    setIsPlaying(true)
  }, [isShuffled])

  const playAll = useCallback((tracks: Track[], playlistId?: string) => {
    if (!tracks.length) return
    const start = isShuffled ? tracks[Math.floor(Math.random() * tracks.length)] : tracks[0]
    playFromList(start, tracks, playlistId)
  }, [isShuffled, playFromList])

  const playFromQueue = useCallback((index: number) => {
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    if (index < 0 || index >= queue.length) return
    const selected = queue[index]
    setPlaybackNotice('')
    currentIndexRef.current = displayQueue.findIndex(track => track.id === selected.id)
    shouldAutoplayRef.current = true
    setLoadVersion(v => v + 1)
    setCurrentTrack(selected)
    setProgress(0)
    setIsPlaying(true)
  }, [isShuffled, queue])

  // 更新 shuffledQueueRef
  useEffect(() => {
    shuffledQueueRef.current = isShuffled ? reconcileShuffle(shuffledQueueRef.current, queue, currentTrack?.id) : []
  }, [queue, isShuffled])

  useEffect(() => {
    const sync = () => {
      const playlistId = sourcePlaylistIdRef.current
      if (!playlistId) return
      const allowed = new Set(getPlaylist(playlistId)?.tracks.map(track => track.id) || [])
      setQueue(prev => {
        const next = prev.filter(track => allowed.has(track.id))
        if (next.length === prev.length) return prev
        const playing = currentTrackRef.current
        if (playing && !allowed.has(playing.id)) {
          const display = isShuffledRef.current && shuffledQueueRef.current.length ? shuffledQueueRef.current : prev
          const picked = trackAfterRemoval(display, allowed, playing.id, repeatModeRef.current === 'all')
          const successor = picked ? next.find(track => track.id === picked.id) ?? null : null
          const wasPlaying = shouldAutoplayRef.current
          queueMicrotask(() => {
            if (!successor) {
              shouldAutoplayRef.current = false
              setCurrentTrack(null)
              setIsPlaying(false)
              setProgress(0)
              currentIndexRef.current = -1
              const notice = next.length === 0 ? '播放列表已经空了' : '列表已播放完'
              setPlaybackNotice(notice)
              if (wasPlaying) showToast(notice)
              const audio = audioRef.current
              if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
              return
            }
            currentIndexRef.current = next.findIndex(track => track.id === successor.id)
            setPlaybackNotice('')
            shouldAutoplayRef.current = wasPlaying
            setLoadVersion(version => version + 1)
            setCurrentTrack(successor)
            setProgress(0)
            setIsPlaying(wasPlaying)
          })
        }
        return next
      })
    }
    window.addEventListener(PLAYLISTS_CHANGED_EVENT, sync)
    return () => window.removeEventListener(PLAYLISTS_CHANGED_EVENT, sync)
  }, [])

  useEffect(() => {
    if (!currentTrack) {
      currentIndexRef.current = -1
      return
    }
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    const index = displayQueue.findIndex(track => track.id === currentTrack.id)
    currentIndexRef.current = index >= 0 ? index : 0
  }, [currentTrack?.id, isShuffled, queue])

  const persistedStateRef = useRef<PersistedPlayerState | null>(null)
  persistedStateRef.current = { currentTrack, queue, progress, duration, volume, isMuted, repeatMode, isShuffled, wasPlaying: isPlaying, currentIndex: currentIndexRef.current, sourcePlaylistId: sourcePlaylistIdRef.current }
  const persistPlayer = useCallback(() => {
    if (!persistEnabledRef.current) return
    try { localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify(persistedStateRef.current)) } catch { /* storage full */ }
  }, [])
  useEffect(() => {
    persistPlayer()
  }, [currentTrack, queue, isPlaying, repeatMode, isShuffled, persistPlayer])
  useEffect(() => {
    const timer = setInterval(persistPlayer, 5000)
    window.addEventListener('beforeunload', persistPlayer)
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', persistPlayer); persistPlayer() }
  }, [persistPlayer])

  useEffect(() => {
    const pushTrayState = () => window.electronAPI?.updateTrayPlayerState?.({
      hasTrack: Boolean(currentTrack),
      title: currentTrack?.title || '未在播放',
      artist: currentTrack?.artist || '搜索并播放音乐',
      coverUrl: currentTrack?.coverUrl || '',
      isPlaying,
      queueLength: queue.length,
      theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
      liked: Boolean(currentTrack?.isLiked),
      lyricsOn: readEnabled(readStoredItem(DESKTOP_LYRICS_KEY)),
      videoOn: readEnabled(localStorage.getItem(VIDEO_WINDOW_KEY)),
      repeatMode,
    })
    pushTrayState()
    // 主题切换时重新推送，使托盘面板跟随浅色/深色
    const observer = new MutationObserver(pushTrayState)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener(DESKTOP_LYRICS_CHANGED_EVENT, pushTrayState)
    window.addEventListener(VIDEO_WINDOW_CHANGED_EVENT, pushTrayState)
    return () => {
      observer.disconnect()
      window.removeEventListener(DESKTOP_LYRICS_CHANGED_EVENT, pushTrayState)
      window.removeEventListener(VIDEO_WINDOW_CHANGED_EVENT, pushTrayState)
    }
  }, [currentTrack?.artist, currentTrack?.coverUrl, currentTrack?.id, currentTrack?.isLiked, currentTrack?.title, isPlaying, queue.length, repeatMode])

  useEffect(() => {
    return window.electronAPI?.onTrayPlayerCommand?.((command) => {
      if (command === 'toggle-play') togglePlay()
      if (command === 'next') next()
      if (command === 'prev') prev()
      if (command === 'toggle-like') {
        const id = currentTrackRef.current?.id
        if (id) toggleLike(id)
      }
      if (command === 'cycle-repeat') {
        const order: RepeatMode[] = ['none', 'all', 'one']
        setRepeatMode(order[(order.indexOf(repeatModeRef.current) + 1) % order.length])
      }
      if (command === 'toggle-lyrics') toggleDesktopLyrics()
      if (command === 'toggle-video') toggleVideoWindow()
    })
  }, [next, prev, toggleLike, togglePlay])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.code !== 'Space' || shouldIgnoreSpaceShortcut(event.target)) return
      event.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlay])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    setMediaSessionAction('play', () => {
      if (!isPlaying) togglePlay()
    })
    setMediaSessionAction('pause', () => {
      if (isPlaying) togglePlay()
    })
    setMediaSessionAction('stop', pause)
    setMediaSessionAction('nexttrack', next)
    setMediaSessionAction('previoustrack', prev)
    setMediaSessionAction('seekbackward', (details) => {
      const step = details.seekOffset || 10
      handleSetProgress(Math.max(0, progressRef.current - step))
    })
    setMediaSessionAction('seekforward', (details) => {
      const step = details.seekOffset || 10
      const nextProgress = durationRef.current > 0
        ? Math.min(durationRef.current, progressRef.current + step)
        : progressRef.current + step
      handleSetProgress(nextProgress)
    })
    setMediaSessionAction('seekto', (details) => {
      if (typeof details.seekTime === 'number') handleSetProgress(Math.max(0, details.seekTime))
    })

    return () => clearMediaSessionActions([
      'play',
      'pause',
      'stop',
      'nexttrack',
      'previoustrack',
      'seekbackward',
      'seekforward',
      'seekto',
    ])
  }, [handleSetProgress, isPlaying, next, pause, prev, togglePlay])

  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return

    if (!currentTrack) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
      return
    }

    const artwork = currentTrack.coverUrl
      ? [{ src: currentTrack.coverUrl, sizes: '512x512', type: getArtworkType(currentTrack.coverUrl) }]
      : undefined

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title || '未命名歌曲',
      artist: currentTrack.artist || 'BiliMusic',
      album: 'BiliMusic',
      artwork,
    })
  }, [currentTrack?.artist, currentTrack?.coverUrl, currentTrack?.id, currentTrack?.title])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = currentTrack ? (isPlaying ? 'playing' : 'paused') : 'none'
  }, [currentTrack, isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack || duration <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(Math.max(progress, 0), duration),
      })
    } catch {
      // Invalid transient durations/progress values should not affect playback.
    }
  }, [currentTrack, duration, progress])

  // 稳定的播放器值：进度（高频）不在其中，故进度跳动不会改变此引用，
  // usePlayer() 的消费者（列表行等）不会因每秒 4 次的进度更新而重渲染。
  const value = useMemo<PlayerContext>(() => ({
    currentTrack,
    isPlaying,
    repeatMode,
    isShuffled,
    queue,
    loadingAudio,
    playbackSource,
    playbackNotice,
    sourcePlaylistId,
    play,
    pause,
    togglePlay,
    next,
    prev,
    setRepeatMode,
    setIsShuffled,
    addToQueue,
    addTracksToQueue,
    removeFromQueue,
    removeMultipleFromQueue,
    moveInQueue,
    playNow,
    playFromList,
    playNext,
    clearQueue,
    toggleLike,
    playAll,
    playFromQueue,
    showToast,
  }), [
    currentTrack, isPlaying, repeatMode, isShuffled, queue, loadingAudio, playbackSource, playbackNotice, sourcePlaylistId,
    play, pause, togglePlay, next, prev, setRepeatMode, setIsShuffled,
    addToQueue, addTracksToQueue, removeFromQueue, removeMultipleFromQueue, moveInQueue,
    playNow, playFromList, playNext, clearQueue, toggleLike, playAll, playFromQueue, showToast,
  ])

  // 进度高频更新（timeupdate ~4Hz）独立成 context，仅 PlayerBar/NowPlaying 订阅
  const progressValue = useMemo<PlayerProgress>(() => ({
    progress,
    duration,
    setProgress: handleSetProgress,
  }), [progress, duration, handleSetProgress])

  const volumeValue = useMemo<VolumeState>(() => ({
    volume,
    isMuted,
    setVolume: handleSetVolume,
    setIsMuted,
  }), [volume, isMuted, handleSetVolume])

  return (
    <PlayerContext.Provider value={value}>
      <VolumeContext.Provider value={volumeValue}>
        <PlayerProgressContext.Provider value={progressValue}>
          <PlayerTree>{children}</PlayerTree>
          {toast && <div className="player-toast">{toast}</div>}
        </PlayerProgressContext.Provider>
      </VolumeContext.Provider>
    </PlayerContext.Provider>
  )
}

export function usePlayer(): PlayerContext {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider')
  return ctx
}

export function usePlayerVolume(): VolumeState {
  const ctx = useContext(VolumeContext)
  if (!ctx) throw new Error('usePlayerVolume must be used within PlayerProvider')
  return ctx
}

export function usePlayerProgress(): PlayerProgress {
  const ctx = useContext(PlayerProgressContext)
  if (!ctx) throw new Error('usePlayerProgress must be used within PlayerProvider')
  return ctx
}
