import { getMusicFeed, type VideoInfo } from '@/services/api'
import { nextFeedSeed, seenTrackIds } from '@/services/recommendationSession'

let discoverWarm: Promise<VideoInfo[]> | null = null

/** 软件一打开就同时去拉发现页的各路歌曲，页面先出来再等结果。 */
export function warmDiscoverFeed(): Promise<VideoInfo[]> {
  if (!discoverWarm) {
    const pending = getMusicFeed({ mode: 'discover', seed: nextFeedSeed(), seenTrackIds, limit: 21 })
    discoverWarm = pending
    pending.catch(() => {
      if (discoverWarm === pending) discoverWarm = null
    })
  }
  return discoverWarm
}

export function takeWarmDiscoverFeed(): Promise<VideoInfo[]> | null {
  const pending = discoverWarm
  discoverWarm = null
  return pending
}
