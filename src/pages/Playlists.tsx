import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Check, CheckSquare, Download, ListMusic, Loader2, Music, Play, Square, Trash2, Undo2, X } from 'lucide-react'
import { LOCATE_PLAYING_EVENT, takeLocateRequest } from '@/components/LocatePlaying'
import { usePlayer } from '@/contexts/PlayerContext'
import { downloadTracks, downloadSingleTrack, isTrackDownloaded, removeDownloadedTrack } from '@/services/downloadManager'
import AddToPlaylistButton from '@/components/AddToPlaylistButton'
import PlaylistBatchAdd from '@/components/PlaylistBatchAdd'
import {
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
  TrackListRow,
} from '@/components/AppleMusicPage'
import { clearLyricCache } from '@/services/lyrics'
import { UnavailableCheckButton } from '@/components/UnavailableTracks'
import {
  deletePlaylist,
  getPlaylist,
  loadAppSettings,
  loadPlaylistHero,
  loadPlaylists,
  savePlaylistHero,
  PLAYLIST_UNDO_EVENT,
  PLAYLISTS_CHANGED_EVENT,
  playlistUndoCount,
  removeTracksFromAllPlaylists,
  removeTracksFromPlaylist,
  undoPlaylistAdd,
} from '@/utils/storage'
import type { PlaylistHeroChoice } from '@/utils/storage'
import type { Playlist, Track } from '@/types'

// Keep effect dependencies stable while a playlist is deleted or missing.
const EMPTY_TRACKS: Track[] = []
const HERO_TONES: Array<{ tone: NonNullable<PlaylistHeroChoice['tone']>; label: string; color: string }> = [
  { tone: 'purple', label: '紫色', color: '#c084fc' },
  { tone: 'blue', label: '蓝色', color: '#38bdf8' },
  { tone: 'pink', label: '粉色', color: '#fb7185' },
  { tone: 'red', label: '红色', color: '#f87171' },
]

function compressHeroImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const maxEdge = 1280
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('这张图片没法用作背景'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      let quality = 0.82
      let data = canvas.toDataURL('image/jpeg', quality)
      while (data.length > 350_000 && quality > 0.4) {
        quality -= 0.15
        data = canvas.toDataURL('image/jpeg', quality)
      }
      if (data.length > 700_000) {
        reject(new Error('这张图片太大了，换一张小一点的'))
        return
      }
      resolve(data)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('这张图片没法打开'))
    }
    img.src = url
  })
}

function usePlaylistWindow(count: number, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 28 })
  useEffect(() => {
    if (!enabled) return
    const scroller = document.querySelector('.app-content')
    if (!(scroller instanceof HTMLElement)) return
    const rowHeight = 72
    const update = () => {
      const node = ref.current
      if (!node) return
      const listTop = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      const start = Math.max(0, Math.floor((scroller.scrollTop - listTop) / rowHeight) - 6)
      const end = Math.min(count, Math.ceil((scroller.scrollTop + scroller.clientHeight - listTop) / rowHeight) + 8)
      setRange(previous => previous.start === start && previous.end === end ? previous : { start, end: Math.max(end, start + 1) })
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      scroller.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [count, enabled])
  return { ref, start: enabled ? range.start : 0, end: enabled ? range.end : count, rowHeight: 72 }
}

export default function Playlists() {
  const { playlistId } = useParams()
  return playlistId ? <PlaylistDetail key={playlistId} playlistId={playlistId} /> : <PlaylistOverview />
}

function PlaylistOverview() {
  const [playlists, setPlaylists] = useState<Playlist[]>(() => loadPlaylists())

  useEffect(() => {
    const sync = () => setPlaylists(loadPlaylists())
    window.addEventListener(PLAYLISTS_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(PLAYLISTS_CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const heroImage = playlists.find(p => p.coverUrl)?.coverUrl

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="All Playlists"
        title="所有歌单"
        subtitle={playlists.length ? `你创建了 ${playlists.length} 个歌单。` : '点击侧边栏播放列表右侧的 +，创建第一个歌单。'}
        image={heroImage}
        tone="purple"
      />

      {playlists.length === 0 ? (
        <EmptyLibrary icon={<ListMusic size={40} />} title="还没有歌单" subtitle="新建歌单后，会立即显示在这里和侧边栏中。" />
      ) : (
        <MusicSection title="我的歌单" icon={<ListMusic size={22} />}>
          <div className="playlist-grid">
            {playlists.map((playlist) => (
              <PlaylistCard key={playlist.id} playlist={playlist} />
            ))}
          </div>
        </MusicSection>
      )}
    </MusicPageShell>
  )
}

function PlaylistCard({ playlist }: { playlist: Playlist }) {
  const cover = playlist.coverUrl || playlist.tracks[0]?.coverUrl
  return (
    <Link to={`/playlists/${playlist.id}`} className="playlist-card">
      <div className="playlist-card__cover">
        {cover ? <img src={cover} alt="" loading="lazy" /> : <Music size={34} />}
      </div>
      <div className="playlist-card__body">
        <h3>{playlist.name}</h3>
        <p>{playlist.tracks.length} 首歌曲</p>
        {playlist.description && <span>{playlist.description}</span>}
      </div>
    </Link>
  )
}

const PlaylistTrackRow = memo(function PlaylistTrackRow({
  track,
  position,
  rowIndex,
  selected,
  editing,
  isCurrent,
  isPlaying,
  downloaded,
  downloading,
  onPointerDown,
  onPlay,
  onDownload,
  onRemove,
}: {
  track: Track
  position: number
  rowIndex: number
  selected: boolean
  editing: boolean
  isCurrent: boolean
  isPlaying: boolean
  downloaded: boolean
  downloading: boolean
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPlay: (track: Track) => void
  onDownload: (track: Track) => void
  onRemove: (trackId: string) => void
}) {
  return (
    <TrackListRow
      track={track}
      index={position}
      rowIndex={rowIndex}
      className={selected ? 'is-selected' : ''}
      isCurrent={isCurrent}
      isPlaying={isPlaying}
      onPlay={() => onPlay(track)}
      onPointerDown={editing ? onPointerDown : undefined}
      leading={editing ? (
        <span className={`playlist-select-button ${selected ? 'is-selected' : ''}`} title={selected ? '取消选择' : '选择'}>
          {selected ? <CheckSquare size={17} /> : <Square size={17} />}
        </span>
      ) : undefined}
      extra={(
        <div className="am-extra-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button
            className="am-icon-button"
            onClick={(event) => {
              event.stopPropagation()
              if (!downloaded) onDownload(track)
            }}
            disabled={downloading || downloaded}
            title={downloaded ? '已下载到本地' : '下载到本地'}
          >
            {downloading ? <Loader2 size={15} className="animate-spin text-accent" /> : downloaded ? <Check size={15} /> : <Download size={15} />}
          </button>
          <AddToPlaylistButton track={track} size={15} />
          {!editing && (
            <button className="am-icon-danger" onClick={(event) => { event.stopPropagation(); onRemove(track.id) }} title="移出歌单">
              <X size={16} />
            </button>
          )}
        </div>
      )}
    />
  )
})

function PlaylistDetail({ playlistId }: { playlistId: string }) {
  const [playlist, setPlaylist] = useState<Playlist | null>(() => getPlaylist(playlistId))
  const [editing, setEditing] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadAllBusy, setDownloadAllBusy] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<string>('')
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [undoCount, setUndoCount] = useState(() => playlistUndoCount(playlistId))
  const player = usePlayer()
  const { showToast } = player
  const navigate = useNavigate()

  const tracks = playlist?.tracks ?? EMPTY_TRACKS
  const shownTracks = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return tracks
    return tracks.filter(track => [track.bvid, track.id, track.title, track.album, track.artist]
      .some(value => value?.toLowerCase().includes(needle)))
  }, [query, tracks])
  const shownRef = useRef(shownTracks)
  const editingRef = useRef(editing)
  const selectedRef = useRef(selectedIds)
  const skipClickRef = useRef(false)
  shownRef.current = shownTracks
  editingRef.current = editing
  selectedRef.current = selectedIds
  const windowed = shownTracks.length > 36
  const listWindow = usePlaylistWindow(shownTracks.length, windowed)
  const [locateNonce, setLocateNonce] = useState(0)
  const handledLocate = useRef(0)
  const [heroChoice, setHeroChoice] = useState<PlaylistHeroChoice | null>(() => loadPlaylistHero(playlistId))
  const [heroPicker, setHeroPicker] = useState(false)
  const heroFileRef = useRef<HTMLInputElement>(null)

  const requestLocate = () => {
    setQuery('')
    setLocateNonce(nonce => nonce + 1)
  }

  const refreshDownloaded = useCallback(() => {
    const set = new Set<string>()
    for (const t of tracks) {
      if (isTrackDownloaded(t.id)) set.add(t.id)
    }
    setDownloadedIds(previous => previous.size === set.size && [...set].every(id => previous.has(id)) ? previous : set)
  }, [tracks])

  useEffect(() => {
    refreshDownloaded()
    window.addEventListener('bilimusic_downloads_changed', refreshDownloaded)
    return () => window.removeEventListener('bilimusic_downloads_changed', refreshDownloaded)
  }, [refreshDownloaded])

  const handleDownloadTrack = async (track: Track) => {
    if (downloadingId || downloadAllBusy) return
    setDownloadingId(track.id)
    try {
      showToast(`开始下载《${track.title}》`)
      await downloadSingleTrack(track)
      showToast(`《${track.title}》下载完成`)
      refreshDownloaded()
    } catch (err: any) {
      showToast(`下载失败: ${err?.message || '未知错误'}`)
    } finally {
      setDownloadingId(null)
    }
  }

  const handleDownloadTracks = async (targetTracks: Track[]) => {
    if (downloadAllBusy || targetTracks.length === 0) return
    setDownloadAllBusy(true)
    const { successCount, failCount } = await downloadTracks(targetTracks, (done, total) => {
      setDownloadProgress(`(${done}/${total})`)
      refreshDownloaded()
    })

    setDownloadAllBusy(false)
    setDownloadProgress('')
    showToast(`批量下载完成：成功 ${successCount} 首${failCount > 0 ? `，失败 ${failCount} 首` : ''}`)
  }

  useEffect(() => {
    const sync = () => setPlaylist(getPlaylist(playlistId))
    sync()
    window.addEventListener(PLAYLISTS_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(PLAYLISTS_CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [playlistId])

  useLayoutEffect(() => {
    const locating = takeLocateRequest(playlistId)
    if (locating) {
      requestLocate()
      return
    }
    if (typeof document === 'undefined') return
    const scroller = document.querySelector('.app-content')
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0
  }, [playlistId])

  useEffect(() => {
    const onLocate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== playlistId) return
      requestLocate()
    }
    window.addEventListener(LOCATE_PLAYING_EVENT, onLocate)
    return () => window.removeEventListener(LOCATE_PLAYING_EVENT, onLocate)
  }, [playlistId])

  useEffect(() => {
    if (!heroPicker || typeof document === 'undefined') return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.am-hero__bg, .am-hero__picker')) return
      setHeroPicker(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHeroPicker(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [heroPicker])

  useEffect(() => {
    if (!locateNonce || handledLocate.current === locateNonce) return
    handledLocate.current = locateNonce
    const currentId = player.currentTrack?.id
    const index = shownTracks.findIndex(track => track.id === currentId)
    const scroller = document.querySelector('.app-content')
    const list = listWindow.ref.current
    if (index < 0 || !(scroller instanceof HTMLElement) || !list) return
    const row = list.querySelector(`[data-playlist-index="${index}"]`)
    if (row instanceof HTMLElement && !windowed) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    const top = listTop + index * listWindow.rowHeight - Math.max(0, (scroller.clientHeight - listWindow.rowHeight) / 2)
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [locateNonce, shownTracks, player.currentTrack?.id, windowed, listWindow.ref, listWindow.rowHeight])

  useEffect(() => {
    const sync = () => setUndoCount(playlistUndoCount(playlistId))
    sync()
    window.addEventListener(PLAYLIST_UNDO_EVENT, sync)
    return () => window.removeEventListener(PLAYLIST_UNDO_EVENT, sync)
  }, [playlistId])

  const heroImage = heroChoice?.image || (heroChoice?.tone ? undefined : (playlist?.coverUrl || tracks[0]?.coverUrl))
  const heroTone = heroChoice?.tone || 'purple'
  const updatedText = useMemo(() => {
    if (!playlist?.updatedAt) return ''
    return new Date(playlist.updatedAt).toLocaleDateString()
  }, [playlist?.updatedAt])

  const applyHero = (choice: PlaylistHeroChoice | null) => {
    savePlaylistHero(playlistId, choice)
    setHeroChoice(choice && (choice.tone || choice.image) ? choice : null)
    setHeroPicker(false)
  }

  const pickHeroFile = (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      showToast('请选择一张图片')
      return
    }
    void compressHeroImage(file).then(image => {
      applyHero({ tone: heroChoice?.tone, image })
    }).catch(err => {
      showToast(err instanceof Error ? err.message : '这张图片没法用作背景')
    })
  }

  const onContextMenu = (event: React.MouseEvent) => {
    if (!editing) return
    const target = event.target
    if (target instanceof Element && target.closest('input, textarea, button, a')) return
    event.preventDefault()
    setSelectedIds(new Set())
  }

  const handleDelete = () => {
    if (!playlist) return
    deletePlaylist(playlist.id)
    navigate('/playlists', { replace: true })
  }

  const forgetLyrics = (ids: string[]) => {
    const stillKept = new Set(loadPlaylists().flatMap(item => item.tracks.map(track => track.id)))
    for (const id of ids) if (!stillKept.has(id)) clearLyricCache(id)
  }

  const dropTracks = (ids: string[]) => {
    if (!playlist || ids.length === 0) return null
    const settings = loadAppSettings()
    if (settings.removeTrackFromAllPlaylists) removeTracksFromAllPlaylists(ids)
    else removeTracksFromPlaylist(playlist.id, ids)
    forgetLyrics(ids)
    const updated = getPlaylist(playlist.id)
    setPlaylist(updated)
    if (settings.deleteDownloadWithTrack) {
      for (const id of ids) {
        void removeDownloadedTrack(id).catch((error: { message?: string }) => {
          showToast(`本地文件没删掉：${error?.message || '未知错误'}`)
        })
      }
    }
    return updated
  }

  const removeSelected = () => {
    if (!playlist || selectedIds.size === 0) return
    dropTracks([...selectedIds])
    setSelectedIds(new Set())
    setEditing(false)
  }

  const removeOne = (trackId: string) => {
    if (!playlist) return
    dropTracks([trackId])
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.delete(trackId)
      return next
    })
  }

  const toggleSelected = (trackId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }

  const allSelected = shownTracks.length > 0 && shownTracks.every(track => selectedIds.has(track.id))
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(shownTracks.map(track => track.id)))
  }

  const toggleEditing = () => {
    setEditing(prev => {
      if (prev) setSelectedIds(new Set())
      return !prev
    })
  }

  const undoAdd = () => {
    const updated = undoPlaylistAdd(playlistId)
    if (!updated) return
    setPlaylist(updated)
    setSelectedIds(new Set())
    showToast('已撤回上一次加入')
  }

  const onRowPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!editingRef.current || event.button !== 0) return
    if ((event.target as HTMLElement).closest('.am-track-row__actions')) return
    const anchor = Number(event.currentTarget.dataset.playlistIndex)
    if (!Number.isInteger(anchor)) return
    const startX = event.clientX
    const startY = event.clientY
    const base = new Set(selectedRef.current)
    let moved = false
    let latest = anchor
    const selectRange = (index: number) => {
      const from = Math.min(anchor, index)
      const to = Math.max(anchor, index)
      const next = new Set(base)
      const list = shownRef.current
      for (let i = from; i <= to; i += 1) {
        const id = list[i]?.id
        if (!id) continue
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      setSelectedIds(next)
    }
    const indexAt = (clientY: number) => {
      const list = listWindow.ref.current
      const count = shownRef.current.length
      if (!list || count === 0) return null
      const raw = Math.floor((clientY - list.getBoundingClientRect().top) / listWindow.rowHeight)
      return Math.min(count - 1, Math.max(0, raw))
    }
    const apply = (clientY: number) => {
      const index = indexAt(clientY)
      if (index == null || index === latest) return
      latest = index
      selectRange(index)
    }
    let pointerY = startY
    let frame = 0
    const scrollStep = () => {
      frame = 0
      const scroller = document.querySelector('.app-content')
      if (!(scroller instanceof HTMLElement)) return
      const rect = scroller.getBoundingClientRect()
      const margin = 64
      let delta = 0
      if (pointerY < rect.top + margin) delta = -Math.max(8, Math.min(36, (rect.top + margin - pointerY) * 0.45))
      else if (pointerY > rect.bottom - margin) delta = Math.max(8, Math.min(36, (pointerY - (rect.bottom - margin)) * 0.45))
      if (delta === 0) return
      const before = scroller.scrollTop
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      scroller.scrollTop = Math.min(max, Math.max(0, before + delta))
      if (scroller.scrollTop !== before) apply(pointerY)
      frame = requestAnimationFrame(scrollStep)
    }
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
      if (!moved) {
        moved = true
        document.body.classList.add('playlist-selecting')
      }
      pointerY = ev.clientY
      apply(ev.clientY)
      if (!frame) frame = requestAnimationFrame(scrollStep)
    }
    const up = () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.classList.remove('playlist-selecting')
      skipClickRef.current = true
      if (!moved) {
        const id = shownRef.current[anchor]?.id
        if (id) toggleSelected(id)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [])

  const visibleTracks = windowed ? shownTracks.slice(listWindow.start, listWindow.end) : shownTracks

  const playRow = useCallback((track: Track) => {
    if (skipClickRef.current) {
      skipClickRef.current = false
      return
    }
    if (editingRef.current) return
    player.playFromList(track, tracks, playlist?.id)
  }, [player, tracks, playlist?.id])

  const downloadTrackRef = useRef(handleDownloadTrack)
  const removeTrackRef = useRef(removeOne)
  downloadTrackRef.current = handleDownloadTrack
  removeTrackRef.current = removeOne
  const downloadRow = useCallback((track: Track) => { void downloadTrackRef.current(track) }, [])
  const removeRow = useCallback((trackId: string) => removeTrackRef.current(trackId), [])

  if (!playlist) {
    return (
      <MusicPageShell>
        <EmptyLibrary icon={<ListMusic size={40} />} title="歌单不存在" subtitle="这个歌单可能已经被删除。" />
        <Link className="am-action am-action--subtle" to="/playlists">返回所有歌单</Link>
      </MusicPageShell>
    )
  }

  return (
    <MusicPageShell onContextMenu={onContextMenu}>
      <MusicHero
        eyebrow="Playlist"
        title={playlist.name}
        subtitle={playlist.description || `${tracks.length} 首歌曲${updatedText ? ` · 更新于 ${updatedText}` : ''}`}
        image={heroImage}
        tone={heroTone}
        photo={Boolean(heroChoice?.image)}
        extra={(
          <>
            <button type="button" className="am-hero__bg" onClick={() => setHeroPicker(open => !open)}>
              更换背景
            </button>
            {heroPicker && (
              <div className="am-hero__picker">
                <button type="button" onClick={() => heroFileRef.current?.click()}>选择图片</button>
                <div className="am-hero__tones">
                  {HERO_TONES.map(item => (
                    <button
                      key={item.tone}
                      type="button"
                      className={`am-hero__tone am-hero__tone--${item.tone}`}
                      style={{ background: item.color }}
                      aria-label={item.label}
                      onClick={() => applyHero({ tone: item.tone })}
                    />
                  ))}
                </div>
                <button type="button" onClick={() => applyHero(null)}>恢复默认</button>
                <input
                  ref={heroFileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => {
                    pickHeroFile(event.target.files?.[0])
                    event.target.value = ''
                  }}
                />
              </div>
            )}
          </>
        )}
        action={(
          <>
            {tracks.length > 0 && (
              <>
                <button className="am-action am-action--primary" onClick={() => player.playAll(tracks, playlist.id)}>
                  <Play size={17} fill="currentColor" />
                  播放全部
                </button>
                <button
                  className="am-action am-action--subtle"
                  onClick={() => handleDownloadTracks(tracks)}
                  disabled={downloadAllBusy}
                >
                  {downloadAllBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  {downloadAllBusy ? `正在下载 ${downloadProgress}` : '下载全部'}
                </button>
              </>
            )}
            {tracks.length > 0 && (
              <UnavailableCheckButton
                tracks={tracks}
                scopeKey={`playlist:${playlist.id}`}
                scopeLabel="这个歌单"
                onRemove={(ids) => { dropTracks(ids) }}
              />
            )}
            <button className="am-action am-action--subtle" onClick={handleDelete}>
              <Trash2 size={16} />
              删除歌单
            </button>
          </>
        )}
      />

      <PlaylistBatchAdd playlistId={playlist.id} onAdded={() => setQuery('')} />

      {tracks.length === 0 ? (
        <EmptyLibrary icon={<Music size={40} />} title="歌单是空的" subtitle="在上面贴上 B 站链接。一个视频里的每个分 P 会单独成为一首。" />
      ) : (
        <MusicSection title="歌曲" icon={<Music size={22} />}>
          <div className={`playlist-editbar ${editing ? 'is-editing' : ''}`}>
            <div>
              <span>{editing ? `已选择 ${selectedIds.size} 首` : query.trim() ? `${shownTracks.length} 首匹配` : `${tracks.length} 首歌曲`}</span>
              <div className="playlist-search-wrap">
                <input
                  className="playlist-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索 BV 号、歌名、视频名、UP 主"
                  aria-label="搜索歌单"
                />
                {query && (
                  <button type="button" className="playlist-search__clear" aria-label="清空搜索" onClick={() => setQuery('')}>
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            <button type="button" onClick={undoAdd} disabled={undoCount === 0}>
              <Undo2 size={15} />
              撤回
            </button>
            {editing && (
              <button type="button" onClick={toggleAll}>
                {allSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                {allSelected ? '取消全选' : '全选'}
              </button>
            )}
            {editing && selectedIds.size > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const selectedList = tracks.filter(t => selectedIds.has(t.id))
                    handleDownloadTracks(selectedList)
                  }}
                  disabled={downloadAllBusy}
                >
                  {downloadAllBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  {downloadAllBusy ? `下载中 ${downloadProgress}` : `下载 (${selectedIds.size})`}
                </button>
                <button type="button" className="playlist-editbar__danger" onClick={removeSelected}>
                  <Trash2 size={16} />
                  移出歌单
                </button>
              </>
            )}
            <button type="button" className="playlist-editbar__primary" onClick={toggleEditing}>
              {editing ? '完成' : '选择'}
            </button>
          </div>
          {shownTracks.length === 0 ? (
            <p className="playlist-search-empty">没有匹配的歌曲</p>
          ) : (
            <div
              ref={listWindow.ref}
              className="am-track-list"
              style={windowed ? { position: 'relative', height: shownTracks.length * listWindow.rowHeight } : undefined}
            >
              {(windowed ? visibleTracks : shownTracks).map((track, offset) => {
                const index = windowed ? listWindow.start + offset : offset
                return (
                <div key={track.id} style={windowed ? { position: 'absolute', top: index * listWindow.rowHeight, left: 0, right: 0, height: listWindow.rowHeight } : undefined}>
                <PlaylistTrackRow
                  track={track}
                  position={index + 1}
                  rowIndex={index}
                  selected={selectedIds.has(track.id)}
                  editing={editing}
                  isCurrent={player.currentTrack?.id === track.id}
                  isPlaying={player.isPlaying}
                  downloaded={downloadedIds.has(track.id)}
                  downloading={downloadingId === track.id}
                  onPointerDown={onRowPointerDown}
                  onPlay={playRow}
                  onDownload={downloadRow}
                  onRemove={removeRow}
                />
                </div>
                )
              })}
            </div>
          )}
        </MusicSection>
      )}
    </MusicPageShell>
  )
}
