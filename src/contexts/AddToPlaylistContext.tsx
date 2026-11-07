import { AnimatePresence, motion } from 'framer-motion'
import { Check, Music, Plus, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { usePlayer } from '@/contexts/PlayerContext'
import { addTrackToPlaylist, createPlaylist, loadPlaylists, PLAYLISTS_CHANGED_EVENT, removeTracksFromPlaylist } from '@/utils/storage'
import type { Playlist, Track } from '@/types'

interface AddToPlaylistContextValue {
  openAddToPlaylist: (track: Track) => void
}

const AddToPlaylistContext = createContext<AddToPlaylistContextValue | null>(null)

export function AddToPlaylistProvider({ children }: { children: ReactNode }) {
  const { showToast } = usePlayer()
  const [track, setTrack] = useState<Track | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[]>(() => loadPlaylists())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const sync = () => setPlaylists(loadPlaylists())
    window.addEventListener(PLAYLISTS_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(PLAYLISTS_CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const close = useCallback(() => {
    setTrack(null)
    setSelected(new Set())
    setNaming(false)
    setDraft('')
  }, [])

  const openAddToPlaylist = useCallback((nextTrack: Track) => {
    const lists = loadPlaylists()
    setPlaylists(lists)
    setSelected(new Set(lists.filter(list => list.tracks.some(item => item.id === nextTrack.id)).map(list => list.id)))
    setNaming(false)
    setDraft('')
    setTrack(nextTrack)
  }, [])

  const toggle = useCallback((playlistId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(playlistId)) next.delete(playlistId)
      else next.add(playlistId)
      return next
    })
  }, [])

  const createNew = useCallback(() => {
    const name = draft.trim()
    if (!name || !track) return
    const created = createPlaylist({ name, coverUrl: track.coverUrl })
    setSelected(prev => new Set(prev).add(created.id))
    setDraft('')
    setNaming(false)
  }, [draft, track])

  const apply = useCallback(() => {
    if (!track) return
    let added = 0
    let removed = 0
    for (const playlist of loadPlaylists()) {
      const has = playlist.tracks.some(item => item.id === track.id)
      const want = selected.has(playlist.id)
      if (want && !has) {
        addTrackToPlaylist(playlist.id, track)
        added += 1
      } else if (!want && has) {
        removeTracksFromPlaylist(playlist.id, [track.id])
        removed += 1
      }
    }
    if (added && removed) showToast(`已加入 ${added} 个歌单，并从 ${removed} 个歌单移出`)
    else if (added) showToast(added === 1 ? '已加入 1 个歌单' : `已加入 ${added} 个歌单`)
    else if (removed) showToast(removed === 1 ? '已从 1 个歌单移出' : `已从 ${removed} 个歌单移出`)
    close()
  }, [close, selected, showToast, track])

  return (
    <AddToPlaylistContext.Provider value={{ openAddToPlaylist }}>
      {children}
      <AnimatePresence>
        {track && (
          <motion.div
            className="add-playlist-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onMouseDown={close}
          >
            <motion.div
              className="add-playlist-popover"
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 14, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 360, damping: 30 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="add-playlist-popover__head">
                <div>
                  <p>Add to Playlist</p>
                  <h3>添加至歌单</h3>
                </div>
                <button type="button" onClick={close} aria-label="关闭">
                  <X size={17} />
                </button>
              </div>

              <div className="add-playlist-track">
                <div>{track.coverUrl ? <img src={track.coverUrl} alt="" /> : <Music size={20} />}</div>
                <span>
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </span>
              </div>

              {naming ? (
                <form className="add-playlist-create" onSubmit={(event) => { event.preventDefault(); createNew() }}>
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="新歌单名称"
                    aria-label="新歌单名称"
                    autoFocus
                  />
                  <button type="submit" disabled={!draft.trim()}>创建</button>
                </form>
              ) : (
                <button type="button" className="add-playlist-new" onClick={() => setNaming(true)}>
                  <Plus size={16} />
                  新建歌单
                </button>
              )}

              <div className="add-playlist-list">
                {playlists.length === 0 ? (
                  <div className="add-playlist-empty">还没有歌单。先在上面新建一个。</div>
                ) : playlists.map((playlist) => {
                  const on = selected.has(playlist.id)
                  return (
                    <button key={playlist.id} type="button" className={on ? 'is-selected' : ''} onClick={() => toggle(playlist.id)}>
                      <span>
                        <strong>{playlist.name}</strong>
                        <small>{playlist.tracks.length} 首歌曲</small>
                      </span>
                      <span className={`add-playlist-check${on ? ' is-on' : ''}`}>{on && <Check size={14} />}</span>
                    </button>
                  )
                })}
              </div>
              <div className="add-playlist-actions">
                <button type="button" onClick={apply}>完成</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </AddToPlaylistContext.Provider>
  )
}

export function useAddToPlaylist() {
  const ctx = useContext(AddToPlaylistContext)
  if (!ctx) throw new Error('useAddToPlaylist must be used within AddToPlaylistProvider')
  return ctx
}
