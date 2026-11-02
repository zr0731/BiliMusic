import { lazy, useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useAutoSync } from '@/hooks/useAutoSync'
import { useSystemThemeBinding } from '@/hooks/useTheme'
import { useDesktopLyricsBridge } from '@/hooks/useDesktopLyrics'
import { useVideoWindowBridge } from '@/hooks/useVideoWindow'
import { PlayerProvider } from '@/contexts/PlayerContext'
import { NowPlayingProvider } from '@/contexts/NowPlayingContext'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { AddToPlaylistProvider } from '@/contexts/AddToPlaylistContext'
import LoginDialog from '@/components/LoginDialog'
import MainLayout from '@/components/layout/MainLayout'
import { warmDiscoverFeed } from '@/services/discoverWarm'
void import('@/pages/Discover')
void import('@/pages/Playlists')
void import('@/pages/Settings')
const Discover = lazy(() => import('@/pages/Discover'))
const SearchPage = lazy(() => import('@/pages/Search'))
const Recommend = lazy(() => import('@/pages/Recommend'))
const Recent = lazy(() => import('@/pages/Recent'))
const Favorites = lazy(() => import('@/pages/Favorites'))
const Playlists = lazy(() => import('@/pages/Playlists'))
const Downloads = lazy(() => import('@/pages/Downloads'))
const Settings = lazy(() => import('@/pages/Settings'))

function GlobalLoginDialog() {
  const { showLogin, setShowLogin, checkLogin } = useAuth()
  if (!showLogin) return null
  return (
    <LoginDialog
      onClose={() => setShowLogin(false)}
      onSuccess={() => {
        setShowLogin(false)
        checkLogin()
      }}
    />
  )
}

function DesktopLyricsBridge() {
  useDesktopLyricsBridge()
  return null
}

function VideoWindowBridge() {
  useVideoWindowBridge()
  return null
}

export default function App() {
  // 渲染层成功挂载后回报主进程：确认当前（可能是 OTA 热补丁的）渲染包可用，避免下次启动误回滚
  useEffect(() => {
    window.electronAPI?.notifyRendererReady?.()
    void warmDiscoverFeed().catch(() => {})
  }, [])
  useSystemThemeBinding()

  // 云同步自动触发（启动 + 改动防抖 + 周期）
  useAutoSync()

  return (
    <AuthProvider>
      <PlayerProvider>
        <NowPlayingProvider>
          <AddToPlaylistProvider>
              <DesktopLyricsBridge />
              <VideoWindowBridge />
              <Routes>
                <Route element={<MainLayout />}>
                  <Route path="/" element={<Discover />} />
                  <Route path="/discover" element={<Discover />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/recommend" element={<Recommend />} />
                  <Route path="/recent" element={<Recent />} />
                  <Route path="/favorites" element={<Favorites />} />
                  <Route path="/playlists" element={<Playlists />} />
                  <Route path="/playlists/:playlistId" element={<Playlists />} />
                  <Route path="/downloads" element={<Downloads />} />
                  <Route path="/settings" element={<Settings />} />
                </Route>
              </Routes>
              <GlobalLoginDialog />
          </AddToPlaylistProvider>
        </NowPlayingProvider>
      </PlayerProvider>
    </AuthProvider>
  )
}
