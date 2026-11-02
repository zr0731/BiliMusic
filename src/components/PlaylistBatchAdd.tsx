import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { BiliApiError } from '@/services/bilibiliApi'
import { importBatchSource, previewBatchVideo } from '@/services/biliBatchImport'
import { BatchSourceError, collectionChoice, parseBatchSource, type BatchProgress, type BatchSource, type CollectionChoice } from '@/services/biliBatchSource'
import { addTracksToPlaylist } from '@/utils/storage'
import { usePlayer } from '@/contexts/PlayerContext'

function progressText(progress: BatchProgress | null): string {
  if (!progress) return '正在读取…'
  if (progress.phase === 'list') return `正在列出视频 ${progress.done}${progress.total > progress.done ? ` / ${progress.total}` : ''}`
  return `正在拆分分 P ${progress.done} / ${progress.total}`
}

function failureText(error: unknown): string {
  if (error instanceof BatchSourceError) return error.message
  if (error instanceof BiliApiError) {
    if (error.code === -101) return '这个收藏夹需要先登录 B 站'
    if (error.code === -404) return '没有找到这个内容'
    if (error.code === -352) return 'B 站暂时拒绝了请求，请稍后再试'
  }
  return '读取失败，请检查网络后再试'
}

function resultText(added: number, skipped: number, failed: number, cancelled: boolean): string {
  if (added === 0 && skipped === 0 && failed === 0) return cancelled ? '已停止' : '没有读到可以加入的分 P'
  if (added === 0 && skipped > 0 && failed === 0) return cancelled ? '已停止，这些分 P 已经在歌单里' : '这些分 P 已经在歌单里'
  const parts = [`已加入 ${added} 首`]
  if (skipped > 0) parts.push(`${skipped} 首已经在歌单里`)
  if (failed > 0) parts.push(`${failed} 个视频这次没读到`)
  if (cancelled) parts.unshift('已停止')
  return parts.join('，')
}

export default function PlaylistBatchAdd({ playlistId, onAdded }: { playlistId: string; onAdded?: () => void }) {
  const { showToast } = usePlayer()
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [status, setStatus] = useState('')
  const [choice, setChoice] = useState<CollectionChoice | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const finish = async (source: BatchSource, controller: AbortController) => {
    try {
      const result = await importBatchSource(source, {
        signal: controller.signal,
        onProgress: setProgress,
      })
      const saved = addTracksToPlaylist(playlistId, result.tracks)
      const message = resultText(saved.added, saved.skipped, result.failed, result.cancelled)
      if (!mountedRef.current) return
      setChoice(null)
      setStatus(message)
      showToast(message)
      if (saved.added > 0) setLink('')
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return
      const message = failureText(error)
      setStatus(message)
      showToast(message)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      if (mountedRef.current) {
        setBusy(false)
        setProgress(null)
      }
    }
  }

  const begin = () => {
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setProgress(null)
    setStatus('正在读取…')
    return controller
  }

  const submit = async () => {
    if (busy) return
    let source: BatchSource
    try {
      source = parseBatchSource(link)
    } catch (error) {
      const message = failureText(error)
      setChoice(null)
      setStatus(message)
      showToast(message)
      return
    }
    const controller = begin()
    onAdded?.()
    setChoice(null)
    if (source.kind === 'video' && source.entry === 'page') {
      let decided = false
      try {
        const detail = await previewBatchVideo(source.bvid)
        if (!mountedRef.current || controller.signal.aborted) return
        const ask = collectionChoice(source, detail)
        if (ask) {
          decided = true
          setChoice(ask)
          const count = ask.season.count > 0 ? `，共 ${ask.season.count} 个视频` : ''
          setStatus(`这条视频属于合集「${ask.season.title}」${count}。要加入整个合集，还是只加这一条？`)
        }
      } catch (error) {
        decided = true
        if (!mountedRef.current || controller.signal.aborted) return
        const message = failureText(error)
        setStatus(message)
        showToast(message)
      } finally {
        if (decided || !mountedRef.current || controller.signal.aborted) {
          if (abortRef.current === controller) abortRef.current = null
          if (mountedRef.current) {
            setBusy(false)
            setProgress(null)
            if (controller.signal.aborted) setStatus('已停止')
          }
        }
      }
      if (decided || !mountedRef.current || controller.signal.aborted) return
    }
    await finish(source, controller)
  }

  const choose = (source: BatchSource) => {
    if (busy) return
    setChoice(null)
    void finish(source, begin())
  }

  return (
    <form
      className="playlist-batch"
      onSubmit={(event) => {
        event.preventDefault()
        if (choice) return
        void submit()
      }}
    >
      <input
        value={link}
        onChange={(event) => {
          setLink(event.target.value)
          setChoice(null)
        }}
        placeholder="贴上 BV 号、视频、UP 主空间、收藏夹或合集链接"
        disabled={busy}
        aria-label="B 站链接"
      />
      {!choice && (
        <button type="submit" disabled={busy || !link.trim()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {busy ? progressText(progress) : '加入歌单'}
        </button>
      )}
      {busy && (
        <button
          type="button"
          onClick={() => {
            abortRef.current?.abort()
            setStatus('正在停止…')
          }}
        >
          停止
        </button>
      )}
      {choice && !busy && (
        <>
          <button
            type="button"
            className="playlist-batch__choice"
            onClick={() => choose({ kind: 'video', bvid: choice.bvid, entry: 'bvid' })}
          >
            只加这个视频
          </button>
          <button
            type="button"
            className="playlist-batch__choice"
            onClick={() => choose({ kind: 'season', mid: choice.season.mid, seasonId: choice.season.seasonId })}
          >
            {choice.season.count > 0 ? `加入整个合集（${choice.season.count}）` : '加入整个合集'}
          </button>
        </>
      )}
      {status && <p>{status}</p>}
    </form>
  )
}
