import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { collectLibraryEntries, probeTrack, removeUnavailableFromLibrary } from '@/services/unavailableLibrary'
import {
  dismissCheckReport,
  getCheckSnapshot,
  startUnavailableCheck,
  subscribeCheck,
} from '@/services/unavailableCheckSession'
import {
  formatCheckedAt,
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
  scopeKey,
  scopeLabel,
  onRemove,
  className = 'am-action am-action--subtle',
}: {
  tracks: Track[]
  scopeKey: string
  scopeLabel: string
  onRemove: (ids: string[]) => void
  className?: string
}) {
  const snapshot = useSyncExternalStore(
    (listener) => subscribeCheck(scopeKey, listener),
    () => getCheckSnapshot(scopeKey),
    () => getCheckSnapshot(scopeKey),
  )
  const checking = snapshot.phase === 'running'
  const percent = snapshot.total > 0 ? Math.min(100, Math.round((snapshot.done / snapshot.total) * 100)) : 0
  const checkedText = formatCheckedAt(snapshot.finishedAt)
  const checkedTitle = snapshot.finishedAt ? new Date(snapshot.finishedAt).toLocaleString() : '还没有检查过'

  const start = () => {
    if (checking || tracks.length === 0) return
    startUnavailableCheck(scopeKey, tracks, scopeLabel)
  }

  return (
    <span className="unavailable-check">
      <button type="button" className={className} onClick={start} disabled={checking || tracks.length === 0} title={checkedTitle}>
        {checking ? <Loader2 size={16} className="animate-spin" /> : null}
        {checking ? `正在核对 ${snapshot.done}/${snapshot.total}` : '检查失效'}
        {checking && (
          <span className="unavailable-check__meter" role="progressbar" aria-valuemin={0} aria-valuemax={snapshot.total} aria-valuenow={snapshot.done}>
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
      </button>
      <span className="unavailable-check-note" title={checkedTitle}>{snapshot.emptyNote || (snapshot.finishedAt ? `上次 ${checkedText}` : checkedText)}</span>
      {snapshot.report && (
        <ReportDialog
          scopeLabel={scopeLabel}
          showPlaces={false}
          gone={snapshot.report.gone}
          temporary={snapshot.report.temporary}
          onClose={() => dismissCheckReport(scopeKey)}
          onRemove={onRemove}
        />
      )}
    </span>
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
