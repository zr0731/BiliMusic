import { useState, useEffect, useCallback, useRef } from 'react'
import type { Track } from '@/types'
import {
  getLyricForTrack,
  searchLyricCandidates,
  chooseLyricCandidate,
  clearLyricCache,
  saveLyricOffset,
  saveNoLyric,
  LYRIC_CHOSEN_EVENT,
  type LyricResult,
  type LyricCandidate,
} from '@/services/lyrics'

export type LyricStatus = 'idle' | 'loading' | 'ok' | 'unsynced' | 'empty'

/**
 * 按当前曲目懒加载歌词（仅当 enabled，即歌词页打开时）。
 * 过期请求丢弃，避免快速切歌时的竞态。
 */
export function useLyrics(track: Track | null, enabled: boolean) {
  const [status, setStatus] = useState<LyricStatus>('idle')
  const [result, setResult] = useState<LyricResult | null>(null)
  const reqIdRef = useRef(0)
  const skipChosenRef = useRef('')

  const load = useCallback(async (t: Track) => {
    const reqId = ++reqIdRef.current
    setStatus('loading')
    setResult(null)
    const res = await getLyricForTrack(t)
    if (reqId !== reqIdRef.current) return // 已切歌，丢弃过期结果
    if (!res || (!res.lines.length && !res.instrumental)) {
      setStatus('empty')
      setResult(null)
      return
    }
    setResult(res)
    setStatus(res.synced ? 'ok' : 'unsynced')
  }, [])

  useEffect(() => {
    if (!enabled || !track) return
    let cancelled = false
    setStatus('loading')
    // 先让播放详情画出来，再解析或请求歌词，避免和打开动画抢同一帧。
    const first = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!cancelled) void load(track)
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(first)
    }
    // 仅在曲目切换或启用时重取
  }, [enabled, track?.id, load])

  useEffect(() => {
    const onChosen = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (!enabled || !track || track.id !== id) return
      if (skipChosenRef.current === id) {
        skipChosenRef.current = ''
        return
      }
      load(track)
    }
    window.addEventListener(LYRIC_CHOSEN_EVENT, onChosen)
    return () => window.removeEventListener(LYRIC_CHOSEN_EVENT, onChosen)
  }, [enabled, track, load])

  const search = useCallback((q: string): Promise<LyricCandidate[]> => searchLyricCandidates(q), [])

  const choose = useCallback(async (record: LyricCandidate): Promise<string | null> => {
    if (!track) return '还没有正在播放的歌'
    skipChosenRef.current = track.id
    setStatus('loading')
    let res: Awaited<ReturnType<typeof chooseLyricCandidate>>
    try {
      res = await chooseLyricCandidate(track.id, record)
    } catch (error) {
      setStatus(result?.lines.length ? (result.synced ? 'ok' : 'unsynced') : 'empty')
      return error instanceof Error ? error.message : '选择失败，请再点一次'
    }
    if (!res.ok) {
      setStatus(result?.lines.length ? (result.synced ? 'ok' : 'unsynced') : 'empty')
      if (result) setResult(result)
      return res.reason
    }
    setResult(res.result)
    setStatus(res.result.synced ? 'ok' : 'unsynced')
    return null
  }, [track, result])

  const writeOffset = useCallback((offset: number) => {
    if (!track || !result) return
    const next = { ...result, offset: Math.max(-15, Math.min(15, Math.round(offset * 2) / 2)) }
    skipChosenRef.current = track.id
    setResult(next)
    saveLyricOffset(track.id, next)
  }, [track, result])

  const setOffset = useCallback((delta: number) => {
    writeOffset((result?.offset || 0) + delta)
  }, [result?.offset, writeOffset])

  const setOffsetTo = useCallback((value: number) => {
    if (!Number.isFinite(value)) return
    writeOffset(value)
  }, [writeOffset])

  const keepEmpty = useCallback(() => {
    if (!track) return
    skipChosenRef.current = track.id
    saveNoLyric(track.id)
    setResult(null)
    setStatus('empty')
  }, [track])

  const retry = useCallback(() => {
    if (!track) return
    clearLyricCache(track.id)
    load(track)
  }, [track, load])

  return { status, result, search, choose, retry, setOffset, setOffsetTo, keepEmpty }
}
