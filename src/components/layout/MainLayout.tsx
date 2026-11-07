import { Suspense, useEffect, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import TrackSkeleton from '@/components/TrackSkeleton'
import { Outlet, useLocation } from 'react-router-dom'
import TitleBar from './TitleBar'
import Sidebar from './Sidebar'
import PlayerBar from './PlayerBar'
import NowPlaying from '@/components/NowPlaying'
import { UnavailableAutoCheck } from '@/components/UnavailableTracks'
import LocatePlaying from '@/components/LocatePlaying'
import { ErrorBoundary } from '@/components/ErrorBoundary'

function BackToTop() {
  const { pathname } = useLocation()
  const [visible, setVisible] = useState(false)
  const onPlaylist = /^\/playlists\/[^/]+$/.test(pathname)

  useEffect(() => {
    if (!onPlaylist) return
    const scroller = document.querySelector('.app-content')
    if (!(scroller instanceof HTMLElement)) return
    const update = () => setVisible(scroller.scrollTop > 240)
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', update)
      setVisible(false)
    }
  }, [onPlaylist, pathname])

  if (!onPlaylist || !visible) return null
  return (
    <button
      type="button"
      className="locate-playing back-to-top"
      onClick={() => document.querySelector('.app-content')?.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <ArrowUp size={15} />
      回到顶部
    </button>
  )
}

function PageFallback() {
  return <TrackSkeleton />
}

export default function MainLayout() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
      }}
    >
      <TitleBar />

      <div
        style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
        }}
      >
        <Sidebar />

        <main
          className="app-content"
          style={{
            flex: 1,
            minWidth: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            background: 'var(--color-background)',
            padding: 'var(--space-lg) var(--space-xl)',
          }}
        >
          <ErrorBoundary>
            <Suspense fallback={<PageFallback />}><Outlet /></Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <BackToTop />
      <LocatePlaying />
      <PlayerBar />

      <NowPlaying />
      <UnavailableAutoCheck />
    </div>
  )
}