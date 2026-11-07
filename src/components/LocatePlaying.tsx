import { Locate } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePlayer } from '@/contexts/PlayerContext'
import { loadPlaylists } from '@/utils/storage'

export const LOCATE_PLAYING_EVENT = 'bilimusic:locate-playing'
const LOCATE_PLAYING_KEY = 'bilimusic:locate-playing'

export function rememberLocateRequest(playlistId: string) {
  try { sessionStorage.setItem(LOCATE_PLAYING_KEY, playlistId) } catch { /* private mode */ }
}

export function takeLocateRequest(playlistId: string) {
  try {
    if (sessionStorage.getItem(LOCATE_PLAYING_KEY) !== playlistId) return false
    sessionStorage.removeItem(LOCATE_PLAYING_KEY)
    return true
  } catch {
    return false
  }
}

export default function LocatePlaying() {
  const player = usePlayer()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const track = player.currentTrack
  if (!track) return null

  const go = () => {
    const lists = loadPlaylists()
    const preferred = player.sourcePlaylistId
      ? lists.find(list => list.id === player.sourcePlaylistId && list.tracks.some(item => item.id === track.id))
      : undefined
    const playlist = preferred ?? lists.find(list => list.tracks.some(item => item.id === track.id))
    if (!playlist) {
      player.showToast('这首歌不在任何歌单里')
      return
    }
    if (pathname === `/playlists/${playlist.id}`) {
      window.dispatchEvent(new CustomEvent(LOCATE_PLAYING_EVENT, { detail: playlist.id }))
      return
    }
    rememberLocateRequest(playlist.id)
    navigate(`/playlists/${playlist.id}`)
  }

  return (
    <button type="button" className="locate-playing" onClick={go} title="回到正在播放的歌曲">
      <Locate size={15} />
      正在播放
    </button>
  )
}
