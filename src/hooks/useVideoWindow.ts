import { useEffect, useRef, useState } from 'react'
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext'
import { useAppSettings } from '@/hooks/useAppSettings'
import { pageCidOf } from '@/services/biliBatchSource'
import { getPlayUrl, getVideoDetail } from '@/services/bilibiliApi'
import { describeSmallVideo, recallSmallVideoInfo, rememberSmallVideo } from '@/services/videoWindowSource'

const STORAGE_KEY = 'bilimusic_video_window'
export const VIDEO_WINDOW_CHANGED_EVENT = 'VIDEO_WINDOW_CHANGED_EVENT'

export function loadVideoWindowEnabled(): boolean {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').enabled === true
  } catch {
    return false
  }
}

export function saveVideoWindowEnabled(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled }))
    window.dispatchEvent(new CustomEvent(VIDEO_WINDOW_CHANGED_EVENT))
  } catch {
    // ignore quota errors
  }
}

function trackBvid(track: { id: string; bvid?: string } | null): string {
  if (!track) return ''
  if (track.bvid?.startsWith('BV')) return track.bvid
  const id = track.id.split(':')[0]
  return id.startsWith('BV') ? id : ''
}

async function loadVideoUrl(
  bvid: string,
  pageCid: string | number | undefined,
  prefer: 480 | 720 | 1080,
): Promise<{ url: string; pixels: number } | null> {
  const hinted = Number(pageCid) || undefined
  const cached = recallSmallVideoInfo(bvid, hinted, prefer)
  if (cached) return cached
  const detail = await getVideoDetail(bvid)
  const cid = hinted || detail.cid
  const again = recallSmallVideoInfo(bvid, cid, prefer)
  if (again) return again
  const play = await getPlayUrl(bvid, cid)
  rememberSmallVideo(bvid, cid, play.dash?.video)
  return describeSmallVideo(play.dash?.video, prefer)
}

/** 把正在播放的曲目同步到桌面上的小窗。声音仍由主播放器负责，小窗只放画面。 */
export function useVideoWindowBridge() {
  const player = usePlayer()
  const { settings } = useAppSettings()
  const prefer: 480 | 720 | 1080 = settings.smallWindowQuality === '1080' ? 1080 : settings.smallWindowQuality === '720' ? 720 : 480
  const { progress } = usePlayerProgress()
  const [enabled, setEnabled] = useState(loadVideoWindowEnabled)
  const progressRef = useRef(progress)
  const holdRef = useRef(false)
  const trackRef = useRef(player.currentTrack)
  const lastSentTime = useRef(-10)
  const pictureFailedRef = useRef(false)
  progressRef.current = progress
  holdRef.current = player.loadingAudio || !player.isPlaying
  trackRef.current = player.currentTrack
  const trackKey = player.currentTrack ? `${player.currentTrack.id}|${player.currentTrack.bvid || ''}|${player.currentTrack.cid || ''}|${prefer}` : ''

  useEffect(() => {
    const sync = () => setEnabled(loadVideoWindowEnabled())
    window.addEventListener(VIDEO_WINDOW_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(VIDEO_WINDOW_CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  useEffect(() => {
    const api = window.electronAPI?.videoWindow
    if (!api?.onClosed) return
    return api.onClosed(() => saveVideoWindowEnabled(false))
  }, [])

  useEffect(() => {
    const api = window.electronAPI?.videoWindow
    if (!api?.onCommand) return
    return api.onCommand(command => {
      if (command === 'next') player.next()
      if (command === 'prev') player.prev()
      if (command === 'toggle') player.togglePlay()
    })
  }, [player])

  useEffect(() => {
    const api = window.electronAPI?.videoWindow
    if (!api) return
    if (!enabled) {
      api.setState({ visible: false })
      lastSentTime.current = -10
      return
    }
    const track = trackRef.current
    const bvid = trackBvid(track)
    const title = track?.title || ''
    if (!bvid) {
      api.setState({
        visible: true,
        url: '',
        title,
        paused: true,
        time: 0,
        quality: '',
        note: player.playbackNotice || (track ? '这首没有视频画面' : '还没有正在播放的歌'),
      })
      return
    }
    let cancelled = false
    api.setState({ visible: true, url: '', title, paused: holdRef.current, time: progressRef.current, note: '正在打开画面…' })
    loadVideoUrl(bvid, track ? pageCidOf(track) : undefined, prefer).then(picked => {
      if (cancelled) return
      lastSentTime.current = progressRef.current
      pictureFailedRef.current = !picked
      const pixels = picked?.pixels || 0
      const quality = !picked || pixels <= 0 ? '' : pixels < prefer ? `${pixels}p（没有 ${prefer}p）` : `${pixels}p`
      api.setState({
        visible: true,
        url: picked?.url || '',
        title,
        quality,
        paused: holdRef.current,
        time: progressRef.current,
        note: picked ? '' : '没有拿到视频画面',
      })
    }).catch(() => {
      if (cancelled) return
      pictureFailedRef.current = true
      api.setState({ visible: true, url: '', title, paused: true, time: 0, note: '画面暂时打不开' })
    })
    return () => { cancelled = true }
  }, [enabled, trackKey])

  useEffect(() => {
    const api = window.electronAPI?.videoWindow
    if (!api?.onPictureFailed) return
    return api.onPictureFailed(() => { pictureFailedRef.current = true })
  }, [])

  const noticeRef = useRef('')
  useEffect(() => {
    const api = window.electronAPI?.videoWindow
    if (!api || !enabled) return
    lastSentTime.current = progressRef.current
    const patch: { paused: boolean; time: number; note?: string } = {
      paused: player.loadingAudio || !player.isPlaying,
      time: progressRef.current,
    }
    if (player.playbackNotice || noticeRef.current) patch.note = player.playbackNotice || ''
    noticeRef.current = player.playbackNotice
    const retry = player.isPlaying && !player.loadingAudio && pictureFailedRef.current
    if (!retry) {
      api.setState(patch)
      return
    }
    pictureFailedRef.current = false
    const track = trackRef.current
    const bvid = trackBvid(track)
    const title = track?.title || ''
    if (!bvid) {
      api.setState(patch)
      return
    }
    let cancelled = false
    api.setState({ visible: true, url: '', title, paused: false, time: progressRef.current, note: '正在打开画面…' })
    loadVideoUrl(bvid, track ? pageCidOf(track) : undefined, prefer).then(picked => {
      if (cancelled) return
      pictureFailedRef.current = !picked
      lastSentTime.current = progressRef.current
      const pixels = picked?.pixels || 0
      const quality = !picked || pixels <= 0 ? '' : pixels < prefer ? `${pixels}p（没有 ${prefer}p）` : `${pixels}p`
      api.setState({
        visible: true,
        url: picked?.url || '',
        title,
        quality,
        paused: holdRef.current,
        time: progressRef.current,
        note: picked ? '' : '没有拿到视频画面',
      })
    }).catch(() => {
      if (cancelled) return
      pictureFailedRef.current = true
      api.setState({ visible: true, url: '', title, paused: holdRef.current, time: progressRef.current, note: '画面暂时打不开' })
    })
    return () => { cancelled = true }
  }, [enabled, player.isPlaying, player.loadingAudio, player.playbackNotice, prefer])

  useEffect(() => {
    const api = window.electronAPI?.videoWindow
    if (!api || !enabled) return
    const jump = Math.abs(progress - lastSentTime.current)
    if (lastSentTime.current >= 0 && jump < 0.05) return
    lastSentTime.current = progress
    api.setState({ time: progress, paused: holdRef.current })
  }, [enabled, progress])
}
