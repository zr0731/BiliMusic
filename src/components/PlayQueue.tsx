import { memo, useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  X,
  Trash2,
  GripVertical,
  Music,
  Play,
  ListStart,
  ListChecks,
  ListPlus,
  Check,
} from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { useAddToPlaylist } from '@/contexts/AddToPlaylistContext'
import type { Track } from '@/types'

const ROW_HEIGHT = 58
const panelSpring = {
  type: 'spring',
  stiffness: 330,
  damping: 28,
  mass: 0.8,
} as const

function useQueueWindow(count: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 18 })
  useEffect(() => {
    const scroller = ref.current
    if (!scroller) return
    const update = () => {
      const start = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - 4)
      const end = Math.min(count, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_HEIGHT) + 6)
      setRange(previous => previous.start === start && previous.end === end ? previous : { start, end: Math.max(end, start + 1) })
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [count])
  return { ref, start: range.start, end: range.end }
}

export default function PlayQueue({ open, onClose }: { open: boolean; onClose: () => void }) {
  const player = usePlayer()
  const { openAddToPlaylist } = useAddToPlaylist()
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const queue = player.queue
  const windowed = useQueueWindow(open ? queue.length : 0)
  const currentId = player.currentTrack?.id
  const selectableIds = queue.filter(t => t.id !== currentId).map(t => t.id)
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id))

  const exitSelect = () => {
    setSelecting(false)
    setSelected(new Set())
  }

  const toggleSelectMode = () => {
    if (selecting) exitSelect()
    else setSelecting(true)
  }

  const toggleSelect = (id: string) => {
    if (id === currentId) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(selectableIds))
  }

  const removeSelected = () => {
    if (selected.size === 0) return
    player.removeMultipleFromQueue([...selected])
    exitSelect()
  }

  const indexAt = (event: DragEvent<HTMLDivElement>) => {
    const scroller = windowed.ref.current
    if (!scroller || queue.length === 0) return 0
    const rect = scroller.getBoundingClientRect()
    const y = scroller.scrollTop + event.clientY - rect.top - 8
    return Math.min(queue.length - 1, Math.max(0, Math.floor(y / ROW_HEIGHT)))
  }

  const onListDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (dragIndex === null) return
    event.preventDefault()
    const scroller = windowed.ref.current
    if (scroller) {
      const rect = scroller.getBoundingClientRect()
      const edge = event.clientY - rect.top
      if (edge < 36) scroller.scrollTop -= 14
      else if (edge > rect.height - 36) scroller.scrollTop += 14
    }
    const index = indexAt(event)
    setOverIndex(previous => previous === index ? previous : index)
  }

  const onListDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const toIndex = overIndex ?? indexAt(event)
    if (dragIndex !== null && dragIndex !== toIndex) player.moveInQueue(dragIndex, toIndex)
    setDragIndex(null)
    setOverIndex(null)
  }

  const visible = queue.slice(windowed.start, windowed.end)

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'transparent' }}
          />

          <motion.div
            initial={{ opacity: 0, y: 22, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.96 }}
            transition={panelSpring}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              right: 24,
              bottom: 96,
              width: 396,
              maxHeight: '65vh',
              zIndex: 61,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 18,
              background: 'var(--queue-bg)',
              border: '1px solid var(--queue-border)',
              boxShadow: 'var(--queue-shadow)',
              overflow: 'hidden',
              color: 'var(--queue-text)',
              fontFamily: "'SF Pro Display', '-apple-system', BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
            } as CSSProperties}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '15px 16px 14px 18px',
                borderBottom: '1px solid var(--queue-divider)',
                background: 'var(--queue-header-bg)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--queue-text)' }}>播放队列</span>
                <span style={{ color: 'var(--queue-text-3)', fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {queue.length} 首歌曲
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <IconButton title={selecting ? '退出多选' : '多选'} active={selecting} disabled={queue.length === 0} onClick={toggleSelectMode}>
                  <ListChecks size={17} />
                </IconButton>
                <IconButton title="清空队列" disabled={queue.length === 0} danger onClick={() => { player.clearQueue(); exitSelect() }}>
                  <Trash2 size={17} />
                </IconButton>
                <div style={{ width: 1, height: 16, background: 'var(--queue-divider)', margin: '0 3px' }} />
                <IconButton title="关闭" onClick={onClose}>
                  <X size={19} />
                </IconButton>
              </div>
            </div>

            <div
              ref={windowed.ref}
              className="sidebar-scroll"
              onDragOver={onListDragOver}
              onDrop={onListDrop}
              style={{ flex: 1, overflowY: 'auto', padding: 8 }}
            >
              {queue.length === 0 ? (
                <EmptyQueue />
              ) : (
                <div style={{ position: 'relative', height: queue.length * ROW_HEIGHT }}>
                  {visible.map((track, offset) => {
                    const index = windowed.start + offset
                    return (
                      <QueueRow
                        key={track.id}
                        track={track}
                        index={index}
                        top={index * ROW_HEIGHT}
                        isCurrent={track.id === currentId}
                        isPlaying={track.id === currentId && player.isPlaying}
                        selecting={selecting}
                        selected={selected.has(track.id)}
                        isDragOver={overIndex === index && dragIndex !== null && dragIndex !== index}
                        onPlay={() => player.play(track)}
                        onSelect={() => toggleSelect(track.id)}
                        onPlayNext={() => player.playNext(track)}
                        onAddToPlaylist={() => openAddToPlaylist(track)}
                        onRemove={() => player.removeFromQueue(track.id)}
                        onDragStart={() => setDragIndex(index)}
                        onDragEnd={() => { setDragIndex(null); setOverIndex(null) }}
                      />
                    )
                  })}
                </div>
              )}
            </div>

            <AnimatePresence>
              {selecting && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22 }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '11px 18px',
                    borderTop: '1px solid var(--queue-divider)',
                    background: 'var(--queue-footer-bg)',
                    overflow: 'hidden',
                  }}
                >
                  <TextButton onClick={toggleSelectAll} disabled={selectableIds.length === 0}>
                    {allSelected ? '取消全选' : '全选'}
                  </TextButton>
                  <span style={{ color: 'var(--queue-text-3)', fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    已选 {selected.size} 项
                  </span>
                  <button
                    type="button"
                    onClick={removeSelected}
                    disabled={selected.size === 0}
                    style={{
                      height: 30,
                      padding: '0 14px',
                      border: 'none',
                      borderRadius: 999,
                      background: selected.size === 0 ? 'var(--queue-row-active)' : '#ff375f',
                      color: selected.size === 0 ? 'var(--queue-text-4)' : '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <Trash2 size={15} /> 移除
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

const QueueRow = memo(function QueueRow({
  track,
  index,
  top,
  isCurrent,
  isPlaying,
  selecting,
  selected,
  isDragOver,
  onPlay,
  onSelect,
  onPlayNext,
  onAddToPlaylist,
  onRemove,
  onDragStart,
  onDragEnd,
}: {
  track: Track
  index: number
  top: number
  isCurrent: boolean
  isPlaying: boolean
  selecting: boolean
  selected: boolean
  isDragOver: boolean
  onPlay: () => void
  onSelect: () => void
  onPlayNext: () => void
  onAddToPlaylist: () => void
  onRemove: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      draggable={!selecting}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(index))
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={selecting ? onSelect : onPlay}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        height: ROW_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 8px 8px 9px',
        boxSizing: 'border-box',
        borderRadius: isDragOver ? 7 : 10,
        background: hover
          ? (selected || isCurrent ? 'var(--queue-row-hover-strong)' : 'var(--queue-row-hover)')
          : (selected || isCurrent ? 'var(--queue-row-active)' : 'transparent'),
        boxShadow: isDragOver ? 'inset 0 2px 0 #ff375f' : undefined,
        cursor: 'pointer',
        overflow: 'hidden',
      }}
    >
      <div style={{ width: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {selecting ? (
          <SelectionBox selected={selected} disabled={isCurrent} />
        ) : isCurrent ? (
          <Equalizer active={isPlaying} />
        ) : (
          <span style={{ color: 'var(--queue-text-3)', display: 'flex', cursor: 'grab', opacity: hover ? 1 : 0 }} title="拖拽调整顺序">
            <GripVertical size={16} />
          </span>
        )}
      </div>
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 8,
          background: 'var(--queue-cover-bg)',
          border: '1px solid var(--queue-cover-border)',
          overflow: 'hidden',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        {track.coverUrl ? (
          <img src={track.coverUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" draggable={false} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Music size={16} style={{ color: 'var(--queue-text-3)' }} />
          </div>
        )}
        {hover && !isCurrent && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0, 0, 0, 0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Play size={16} fill="currentColor" style={{ color: '#fff', marginLeft: 1 }} />
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingRight: 4 }}>
        <div style={{ color: isCurrent ? '#ff4f7a' : 'var(--queue-text)', fontSize: 13, fontWeight: isCurrent ? 700 : 600, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {track.title}
        </div>
        <div style={{ marginTop: 4, color: hover ? 'var(--queue-text-2)' : 'var(--queue-text-3)', fontSize: 12, fontWeight: 500, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {track.artist}
        </div>
      </div>
      {!selecting && hover && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <IconButton title="添加至歌单" onClick={(e) => { e.stopPropagation(); onAddToPlaylist() }}>
            <ListPlus size={16} />
          </IconButton>
          {!isCurrent && (
            <IconButton title="下一首播放" onClick={(e) => { e.stopPropagation(); onPlayNext() }}>
              <ListStart size={16} />
            </IconButton>
          )}
          <IconButton title="从队列移除" danger onClick={(e) => { e.stopPropagation(); onRemove() }}>
            <Trash2 size={16} />
          </IconButton>
        </div>
      )}
    </div>
  )
})

function Equalizer({ active }: { active: boolean }) {
  return (
    <div style={{ height: 16, display: 'flex', alignItems: 'end', gap: 2 }}>
      {[0.78, 0.92, 0.68].map((duration, index) => (
        <span
          key={index}
          style={{
            width: 3,
            height: active ? 14 : 5,
            borderRadius: 999,
            background: '#ff375f',
            transformOrigin: 'bottom',
            animation: active ? `am-eq ${duration}s ease-in-out infinite alternate` : undefined,
          }}
        />
      ))}
    </div>
  )
}

function SelectionBox({ selected, disabled }: { selected: boolean; disabled: boolean }) {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 5,
        border: `1px solid ${selected ? '#ff375f' : 'var(--queue-selbox-border)'}`,
        background: selected ? '#ff375f' : 'var(--queue-selbox-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : 1,
        boxSizing: 'border-box',
      }}
    >
      {selected && <Check size={12} strokeWidth={3} style={{ color: '#fff' }} />}
    </span>
  )
}

function EmptyQueue() {
  return (
    <div style={{ minHeight: 190, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--queue-text-3)' }}>
      <Music size={38} strokeWidth={1.2} />
      <span style={{ fontSize: 13, fontWeight: 600 }}>队列为空</span>
    </div>
  )
}

function IconButton({
  children,
  title,
  active = false,
  disabled = false,
  danger = false,
  onClick,
}: {
  children: ReactNode
  title: string
  active?: boolean
  disabled?: boolean
  danger?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        width: 30,
        height: 30,
        padding: 0,
        borderRadius: 9,
        border: 'none',
        background: active ? 'rgba(255, 55, 95, 0.12)' : 'transparent',
        color: disabled ? 'var(--queue-text-4)' : active ? (danger ? '#ff453a' : '#ff375f') : 'var(--queue-icon)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function TextButton({ children, disabled, onClick }: { children: ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: 0,
        background: 'none',
        border: 'none',
        color: disabled ? 'var(--queue-text-4)' : '#ff4f7a',
        fontSize: 13,
        fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}
