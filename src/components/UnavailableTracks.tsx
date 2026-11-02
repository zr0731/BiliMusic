import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { collectLibraryEntries, probeTrack, removeUnavailableFromLibrary } from '@/services/unavailableLibrary'
import {
  inspectAvailability,
  shouldRunUnavailableCheck,
  type UnavailableItem,
} from '@/services/unavailableTracks'
import { loadAppSettings } from '@/utils/storage'
import type { Track } from '@/types'

const CHECKED_AT_KEY = 'bilimusic_unavailable_checked_at'

function readCheckedAt(): number | null {
  const value = Number(localStorage.getItem(CHECKED_AT_KEY) || 0)
  return value > 0 ? value : null
}

function writeCheckedAt(now: number) {
  localStorage.setItem(CHECKED_AT_KEY, String(now))
}

function ReportDialog({
  scopeLabel,
  showPlaces,
  gone,
  temporary,
  onClose,
  onRemove,
}: {
  scopeLabel: string
  showPlaces: boolean
  gone: UnavailableItem[]
  temporary: UnavailableItem[]
  onClose: () => void
  onRemove: (ids: string[]) => void
}) {
  return createPortal(
    <div className="unavailable-dialog" role="dialog" aria-modal="true" aria-labelledby="unavailable-dialog-title">
      <div className="unavailable-dialog__panel">
        <h2 id="unavailable-dialog-title">{gone.length ? '这些曲目已经失效' : '这次没能确认'}</h2>
        <p>
          {gone.length
            ? `确认后才会从${scopeLabel}里去掉。网络失败，以及稿件还在但暂时看不了的，都不会删。`
            : '没有确认稿件已经不在，所以一首都不会删。'}
        </p>
        {gone.length > 0 && (
          <>
            <h3>会清除</h3>
            <ul>{gone.map(item => <ReportRow key={item.id} item={item} showPlaces={showPlaces} />)}</ul>
          </>
        )}
        {temporary.length > 0 && (
          <>
            <h3>先留着</h3>
            <ul>{temporary.map(item => <ReportRow key={item.id} item={item} showPlaces={showPlaces} />)}</ul>
          </>
        )}
        <div className="unavailable-dialog__actions">
          {gone.length > 0 && (
            <button type="button" className="am-action am-action--primary" onClick={() => { onRemove(gone.map(item => item.id)); onClose() }}>
              清除失效曲目
            </button>
          )}
          <button type="button" className="am-action am-action--subtle" onClick={onClose}>
            {gone.length ? '取消' : '知道了'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ReportRow({ item, showPlaces }: { item: UnavailableItem; showPlaces: boolean }) {
  return (
    <li>
      <strong>{item.title || '未命名'}</strong>
      <span>{item.artist || '未知 UP 主'}</span>
      <span>{item.bvid || '没有 BV 号'}</span>
      <span>{item.reason}</span>
      {showPlaces && item.places.length > 0 && <span className="unavailable-dialog__places">{item.places.join('、')}</span>}
    </li>
  )
}

export function UnavailableCheckButton({
  tracks,
  scopeLabel,
  onRemove,
  className = 'am-action am-action--subtle',
}: {
  tracks: Track[]
  scopeLabel: string
  onRemove: (ids: string[]) => void
  className?: string
}) {
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [report, setReport] = useState<{ gone: UnavailableItem[]; temporary: UnavailableItem[] } | null>(null)
  const [emptyNote, setEmptyNote] = useState('')
  const runId = useRef(0)

  useEffect(() => () => { runId.current += 1 }, [])

  const start = () => {
    if (checking || tracks.length === 0) return
    const id = ++runId.current
    setChecking(true)
    setEmptyNote('')
    setProgress({ done: 0, total: tracks.length })
    void inspectAvailability(
      tracks.map(track => ({ track, places: [scopeLabel] })),
      probeTrack,
      {
        isCancelled: () => runId.current !== id,
        onProgress: (done, total) => { if (runId.current === id) setProgress({ done, total }) },
      },
    ).then(result => {
      if (runId.current !== id) return
      setChecking(false)
      if (!result) return
      if (result.gone.length === 0 && result.temporary.length === 0) {
        setEmptyNote('没有失效曲目')
        return
      }
      setReport(result)
    }).catch(() => {
      if (runId.current !== id) return
      setChecking(false)
      setReport({
        gone: [],
        temporary: tracks.filter(track => /^BV[0-9A-Za-z]{10}$/.test(track.bvid || '')).map(track => ({
          id: track.id,
          title: track.title,
          artist: track.artist,
          bvid: track.bvid,
          reason: '网络失败',
          places: [scopeLabel],
        })),
      })
    })
  }

  return (
    <>
      <button type="button" className={className} onClick={start} disabled={checking || tracks.length === 0}>
        {checking ? <Loader2 size={16} className="animate-spin" /> : null}
        {checking ? `正在核对 ${progress.done}/${progress.total}` : '检查失效'}
      </button>
      {emptyNote && <span className="unavailable-check-note">{emptyNote}</span>}
      {report && (
        <ReportDialog
          scopeLabel={scopeLabel}
          showPlaces={false}
          gone={report.gone}
          temporary={report.temporary}
          onClose={() => setReport(null)}
          onRemove={onRemove}
        />
      )}
    </>
  )
}

export function UnavailableAutoCheck() {
  const [report, setReport] = useState<{ gone: UnavailableItem[]; temporary: UnavailableItem[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      const mode = loadAppSettings().unavailableCheck
      if (!shouldRunUnavailableCheck(mode, readCheckedAt(), Date.now())) return
      const entries = collectLibraryEntries()
      if (entries.length === 0) return
      void inspectAvailability(entries, probeTrack, { isCancelled: () => cancelled }).then(result => {
        if (cancelled || !result) return
        writeCheckedAt(Date.now())
        if (result.gone.length === 0 && result.temporary.length === 0) return
        setReport(result)
      }).catch(() => {
        // 整次检查没有完成时不记时间，下次打开再试。
      })
    }, 2800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  if (!report) return null
  return (
    <ReportDialog
      scopeLabel="歌单、最近播放和我喜欢"
      showPlaces
      gone={report.gone}
      temporary={report.temporary}
      onClose={() => setReport(null)}
      onRemove={removeUnavailableFromLibrary}
    />
  )
}
