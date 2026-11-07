import { canPlayByAvidCid, getVideoDetail } from '@/services/bilibiliApi'
import { classifyThrown, classifyViewCode, type InspectableTrack, type UnavailableVerdict } from '@/services/unavailableTracks'
import type { Track } from '@/types'
import {
  loadFavoriteTracks,
  loadPlaylists,
  loadRecentTracks,
  removeMultipleFavoriteTracks,
  removeRecentTracks,
  removeTracksFromAllPlaylists,
} from '@/utils/storage'
import { clearLyricCache } from '@/services/lyrics'

export interface LibraryEntry {
  track: Track
  places: string[]
}

export function collectLibraryEntries(): LibraryEntry[] {
  const entries: LibraryEntry[] = []
  for (const playlist of loadPlaylists()) {
    const place = `歌单「${playlist.name}」`
    for (const track of playlist.tracks) entries.push({ track, places: [place] })
  }
  for (const track of loadFavoriteTracks()) entries.push({ track, places: ['我喜欢'] })
  for (const track of loadRecentTracks()) entries.push({ track, places: ['最近播放'] })
  return entries
}

export async function probeTrack(track: InspectableTrack & { aid?: string | number; cid?: string | number }): Promise<'ok' | UnavailableVerdict> {
  const bvid = track.bvid?.trim() || ''
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return 'ok'
  const probeView = window.electronAPI?.biliApi?.probeView
  if (probeView) {
    try {
      const result = await probeView(bvid)
      if (!result || result.code === 0) return 'ok'
      const verdict = classifyViewCode(result.code)
      if (verdict.kind !== 'gone' || !track.aid || !track.cid) return verdict
      try {
        await canPlayByAvidCid(track.aid, track.cid)
        return 'ok'
      } catch (fallbackError) {
        const fallback = classifyThrown(fallbackError)
        return fallback.kind === 'temporary' ? fallback : verdict
      }
    } catch (error) {
      return classifyThrown(error)
    }
  }
  try {
    await getVideoDetail(bvid)
    return 'ok'
  } catch (error) {
    const verdict = classifyThrown(error)
    if (verdict.kind !== 'gone' || !track.aid || !track.cid) return verdict
    try {
      await canPlayByAvidCid(track.aid, track.cid)
      return 'ok'
    } catch (fallbackError) {
      const fallback = classifyThrown(fallbackError)
      return fallback.kind === 'temporary' ? fallback : verdict
    }
  }
}

export function removeUnavailableFromLibrary(ids: string[]) {
  if (ids.length === 0) return
  removeTracksFromAllPlaylists(ids)
  const favoriteIds = loadFavoriteTracks().filter(track => ids.includes(track.id)).map(track => track.id)
  if (favoriteIds.length > 0) removeMultipleFavoriteTracks(favoriteIds)
  removeRecentTracks(ids)
  const stillKept = new Set(loadPlaylists().flatMap(playlist => playlist.tracks.map(track => track.id)))
  for (const id of ids) {
    if (!stillKept.has(id)) clearLyricCache(id)
  }
}
