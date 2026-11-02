import type { AppSettings, Playlist, Tombstone, Track } from '@/types'
import { readStoredItem, writeStoredItem } from '@/utils/persistentStorage'

const RECENT_KEY = 'bilimusic_recent'
const FAVORITES_KEY = 'bilimusic_favorites'
const PLAYLISTS_KEY = 'bilimusic_playlists'
const PLAYLIST_TOMBSTONES_KEY = 'bilimusic_playlists_deleted'
const FAVORITE_TOMBSTONES_KEY = 'bilimusic_favorites_deleted'
const SETTINGS_KEY = 'bilimusic_settings'
export const PLAYLISTS_CHANGED_EVENT = 'bilimusic:playlists-changed'
export const PLAYLIST_UNDO_EVENT = 'bilimusic:playlist-undo'

type PlaylistUndo = { playlistId: string; trackIds: string[] }
let playlistUndo: PlaylistUndo | null = null

function rememberPlaylistUndo(playlistId: string, trackIds: string[]) {
  if (trackIds.length === 0) return
  playlistUndo = { playlistId, trackIds }
  window.dispatchEvent(new Event(PLAYLIST_UNDO_EVENT))
}

export function playlistUndoCount(playlistId: string): number {
  return playlistUndo?.playlistId === playlistId ? playlistUndo.trackIds.length : 0
}

export function undoPlaylistAdd(playlistId: string): Playlist | null {
  if (!playlistUndo || playlistUndo.playlistId !== playlistId) return null
  const ids = playlistUndo.trackIds
  playlistUndo = null
  window.dispatchEvent(new Event(PLAYLIST_UNDO_EVENT))
  return removeTracksFromPlaylist(playlistId, ids)
}
export const FAVORITES_CHANGED_EVENT = 'bilimusic:favorites-changed'
export const SETTINGS_CHANGED_EVENT = 'bilimusic:settings-changed'

export const DEFAULT_APP_SETTINGS: AppSettings = {
  sidebarState: 'auto',
  playQuality: '高品质',
  downloadQuality: '高品质',
  downloadDir: '',
  downloadFormat: 'mp3',
  autoPlay: true,
  showLyrics: true,
  resumeOnLaunch: false,
  smallWindowQuality: '480',
  unavailableCheck: 'off',
}

function notifySettingsChanged() {
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT))
}

export function loadRecentTracks(): Track[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export const RECENT_CHANGED_EVENT = 'bilimusic:recent-changed'

export function saveRecentTracks(tracks: Track[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(tracks.slice(0, 50)))
    window.dispatchEvent(new CustomEvent(RECENT_CHANGED_EVENT))
  } catch { /* ignore */ }
}

export function removeRecentTracks(ids: string[]) {
  const drop = new Set(ids)
  saveRecentTracks(loadRecentTracks().filter(track => !drop.has(track.id)))
}

export function addRecentTrack(track: Track) {
  const recent = loadRecentTracks().filter(t => t.id !== track.id)
  recent.unshift({ ...track, isLiked: track.isLiked })
  saveRecentTracks(recent)
}

export function loadFavoriteTracks(): Track[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveFavoriteTracks(tracks: Track[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(tracks))
    window.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT))
  } catch { /* ignore */ }
}

export function toggleFavoriteTrack(track: Track): Track[] {
  const favs = loadFavoriteTracks()
  const idx = favs.findIndex(t => t.id === track.id)
  if (idx >= 0) {
    favs.splice(idx, 1)
    addTombstone(FAVORITE_TOMBSTONES_KEY, track.id) // 取消收藏 → 记墓碑
  } else {
    favs.unshift({ ...track, isLiked: true, likedAt: new Date().toISOString() })
    removeTombstone(FAVORITE_TOMBSTONES_KEY, track.id) // 重新收藏 → 清墓碑
  }
  saveFavoriteTracks(favs)
  return favs
}

// 从收藏移除并记墓碑（供收藏页删除使用，确保同步不复活）
export function removeFavoriteTrack(id: string): Track[] {
  const favs = loadFavoriteTracks().filter(t => t.id !== id)
  addTombstone(FAVORITE_TOMBSTONES_KEY, id)
  saveFavoriteTracks(favs)
  return favs
}

export function removeMultipleFavoriteTracks(ids: string[]): Track[] {
  const idSet = new Set(ids)
  const favs = loadFavoriteTracks().filter(t => !idSet.has(t.id))
  for (const id of ids) {
    addTombstone(FAVORITE_TOMBSTONES_KEY, id)
  }
  saveFavoriteTracks(favs)
  return favs
}

function notifyPlaylistsChanged() {
  window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED_EVENT))
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `playlist_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// ===== 删除墓碑（云同步用）=====
function loadTombstones(key: string): Tombstone[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}
function saveTombstones(key: string, list: Tombstone[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}
function addTombstone(key: string, id: string): void {
  const list = loadTombstones(key).filter((t) => t.id !== id)
  list.push({ id, deletedAt: new Date().toISOString() })
  saveTombstones(key, list)
}
function removeTombstone(key: string, id: string): void {
  saveTombstones(key, loadTombstones(key).filter((t) => t.id !== id))
}
export function loadPlaylistTombstones(): Tombstone[] {
  return loadTombstones(PLAYLIST_TOMBSTONES_KEY)
}
export function savePlaylistTombstones(list: Tombstone[]): void {
  saveTombstones(PLAYLIST_TOMBSTONES_KEY, list)
}
export function loadFavoriteTombstones(): Tombstone[] {
  return loadTombstones(FAVORITE_TOMBSTONES_KEY)
}
export function saveFavoriteTombstones(list: Tombstone[]): void {
  saveTombstones(FAVORITE_TOMBSTONES_KEY, list)
}

let playlistCacheRaw: string | null = null
let playlistCache: Playlist[] = []

export function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY) || ''
    if (raw === playlistCacheRaw) return playlistCache
    playlistCacheRaw = raw
    playlistCache = raw ? JSON.parse(raw) : []
    return playlistCache
  } catch {
    playlistCacheRaw = null
    playlistCache = []
    return playlistCache
  }
}

export function savePlaylists(playlists: Playlist[]) {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists))
    notifyPlaylistsChanged()
  } catch {
    // ignore
  }
}

export function createPlaylist(input: { name: string; description?: string; coverUrl?: string }): Playlist {
  const now = new Date().toISOString()
  const playlist: Playlist = {
    id: createId(),
    name: input.name.trim(),
    description: input.description?.trim() || '',
    coverUrl: input.coverUrl?.trim() || '',
    tracks: [],
    createdAt: now,
    updatedAt: now,
  }
  savePlaylists([playlist, ...loadPlaylists()])
  return playlist
}

export function getPlaylist(id: string): Playlist | null {
  return loadPlaylists().find(p => p.id === id) || null
}

export function updatePlaylist(updated: Playlist): void {
  const playlists = loadPlaylists()
  savePlaylists(playlists.map(p => p.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : p))
}

export function deletePlaylist(id: string): void {
  addTombstone(PLAYLIST_TOMBSTONES_KEY, id) // 记墓碑，避免同步后被对端复活
  savePlaylists(loadPlaylists().filter(p => p.id !== id))
}

export function addTracksToPlaylist(playlistId: string, tracks: Track[]): { playlist: Playlist | null; added: number; skipped: number } {
  const playlists = loadPlaylists()
  let updatedPlaylist: Playlist | null = null
  let added = 0
  let skipped = 0
  const updated = playlists.map((playlist) => {
    if (playlist.id !== playlistId) return playlist
    const seen = new Set(playlist.tracks.map(item => item.id))
    const fresh: Track[] = []
    for (const track of tracks) {
      if (!track.id || seen.has(track.id)) {
        skipped += 1
        continue
      }
      seen.add(track.id)
      fresh.push(track)
      added += 1
    }
    const next = [...fresh, ...playlist.tracks]
    updatedPlaylist = {
      ...playlist,
      coverUrl: playlist.coverUrl || next.find(item => item.coverUrl)?.coverUrl || '',
      tracks: next,
      updatedAt: new Date().toISOString(),
    }
    rememberPlaylistUndo(playlistId, fresh.map(track => track.id))
    return updatedPlaylist
  })
  if (updatedPlaylist) savePlaylists(updated)
  return { playlist: updatedPlaylist, added, skipped }
}

export function addTrackToPlaylist(playlistId: string, track: Track): Playlist | null {
  const playlists = loadPlaylists()
  let updatedPlaylist: Playlist | null = null
  const updated = playlists.map((playlist) => {
    if (playlist.id !== playlistId) return playlist
    const exists = playlist.tracks.some(t => t.id === track.id)
    if (!exists && track.id) rememberPlaylistUndo(playlistId, [track.id])
    updatedPlaylist = {
      ...playlist,
      coverUrl: playlist.coverUrl || track.coverUrl,
      tracks: exists ? playlist.tracks : [track, ...playlist.tracks],
      updatedAt: new Date().toISOString(),
    }
    return updatedPlaylist
  })
  if (updatedPlaylist) savePlaylists(updated)
  return updatedPlaylist
}

function normalizeSmallWindowQuality(value: unknown): AppSettings['smallWindowQuality'] | '' {
  if (value === '1080' || value === '1080p' || value === 1080) return '1080'
  if (value === '720' || value === '720p' || value === 720) return '720'
  if (value === '480' || value === '480p' || value === 480) return '480'
  return ''
}

function readDurableSmallWindowQuality(): AppSettings['smallWindowQuality'] | '' {
  if (typeof window === 'undefined') return ''
  try {
    return normalizeSmallWindowQuality(window.electronAPI?.getSmallWindowQuality?.())
  } catch {
    return ''
  }
}

function writeDurableSmallWindowQuality(value: AppSettings['smallWindowQuality']) {
  if (typeof window === 'undefined') return
  try {
    window.electronAPI?.setSmallWindowQuality?.(value)
  } catch {
    // 主进程还没接上时，页面里的设置仍然在。
  }
}

export function loadAppSettings(): AppSettings {
  try {
    const raw = readStoredItem(SETTINGS_KEY)
    const saved = raw ? JSON.parse(raw) : {}
    const fromFile = readDurableSmallWindowQuality()
    const fromPage = normalizeSmallWindowQuality(saved.smallWindowQuality)
    const smallWindowQuality = fromFile || fromPage || '480'
    if (!fromFile && fromPage) writeDurableSmallWindowQuality(smallWindowQuality)
    const unavailableCheck = saved.unavailableCheck === 'launch' || saved.unavailableCheck === 'weekly' ? saved.unavailableCheck : 'off'
    return {
      ...DEFAULT_APP_SETTINGS,
      ...saved,
      downloadFormat: saved.downloadFormat === 'm4a' ? 'm4a' : 'mp3',
      smallWindowQuality,
      unavailableCheck,
    }
  } catch {
    return DEFAULT_APP_SETTINGS
  }
}

export function saveAppSettings(settings: AppSettings) {
  try {
    const smallWindowQuality = normalizeSmallWindowQuality(settings.smallWindowQuality) || '480'
    const next = { ...settings, smallWindowQuality }
    writeStoredItem(SETTINGS_KEY, JSON.stringify(next))
    writeDurableSmallWindowQuality(smallWindowQuality)
    notifySettingsChanged()
  } catch {
    // ignore
  }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadAppSettings(), ...patch }
  saveAppSettings(next)
  return next
}

export function createPlaylistsExport() {
  return {
    app: 'biliMusic',
    type: 'playlists',
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists: loadPlaylists(),
  }
}

function isPlainPlaylist(value: unknown): value is Playlist {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Playlist>
  return typeof item.name === 'string' && Array.isArray(item.tracks)
}

export function importPlaylistsFromText(text: string): { imported: number; skipped: number } {
  const parsed = JSON.parse(text)
  const incoming = Array.isArray(parsed) ? parsed : parsed?.playlists
  if (!Array.isArray(incoming)) {
    throw new Error('文件中没有找到歌单列表')
  }

  const now = new Date().toISOString()
  const existing = loadPlaylists()
  const existingIds = new Set(existing.map(playlist => playlist.id))
  const existingNames = new Set(existing.map(playlist => playlist.name.trim()))
  const imported: Playlist[] = []
  let skipped = 0

  for (const item of incoming) {
    if (!isPlainPlaylist(item)) {
      skipped += 1
      continue
    }

    const name = item.name.trim()
    if (!name) {
      skipped += 1
      continue
    }

    const id = item.id && !existingIds.has(item.id) ? item.id : createId()
    existingIds.add(id)
    const finalName = existingNames.has(name) ? `${name} 导入` : name
    existingNames.add(finalName)

    imported.push({
      id,
      name: finalName,
      description: item.description || '',
      coverUrl: item.coverUrl || item.tracks[0]?.coverUrl || '',
      tracks: item.tracks,
      createdAt: item.createdAt || now,
      updatedAt: now,
    })
  }

  if (imported.length > 0) {
    savePlaylists([...imported, ...existing])
  }

  return { imported: imported.length, skipped }
}

export function removeTracksFromAllPlaylists(trackIds: string[]) {
  const drop = new Set(trackIds)
  if (drop.size === 0) return
  let changed = false
  const playlists = loadPlaylists().map(playlist => {
    const tracks = playlist.tracks.filter(track => !drop.has(track.id))
    if (tracks.length === playlist.tracks.length) return playlist
    changed = true
    return { ...playlist, tracks, updatedAt: new Date().toISOString() }
  })
  if (changed) savePlaylists(playlists)
}

export function removeTracksFromPlaylist(playlistId: string, trackIds: string[]): Playlist | null {
  const ids = new Set(trackIds)
  if (ids.size === 0) return getPlaylist(playlistId)
  const playlists = loadPlaylists()
  let updatedPlaylist: Playlist | null = null
  const updated = playlists.map((playlist) => {
    if (playlist.id !== playlistId) return playlist
    updatedPlaylist = {
      ...playlist,
      tracks: playlist.tracks.filter(track => !ids.has(track.id)),
      updatedAt: new Date().toISOString(),
    }
    return updatedPlaylist
  })
  if (updatedPlaylist) savePlaylists(updated)
  return updatedPlaylist
}
