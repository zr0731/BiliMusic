import type { Track } from '@/types'

export function shuffleArray<T>(items: T[], random = Math.random): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Keep the selected song first so a complete shuffle cycle visits every song once. */
export function shuffledFrom(tracks: Track[], currentId?: string): Track[] {
  const current = tracks.find(track => track.id === currentId)
  const rest = shuffleArray(tracks.filter(track => track.id !== currentId))
  return current ? [current, ...rest] : rest
}

/** Metadata/like changes must not shuffle tracks already visited in this cycle. */
export function reconcileShuffle(previous: Track[], tracks: Track[], currentId?: string): Track[] {
  if (!previous.length) return shuffledFrom(tracks, currentId)
  const byId = new Map(tracks.map(track => [track.id, track]))
  const kept = previous.flatMap(track => byId.has(track.id) ? [byId.get(track.id)!] : [])
  const seen = new Set(kept.map(track => track.id))
  return [...kept, ...shuffleArray(tracks.filter(track => !seen.has(track.id)))]
}

/**
 * The song being played was removed. Continue with the next remaining song.
 * Do not jump back to the first song unless the list is set to repeat.
 */
export function trackAfterRemoval(display: Track[], allowedIds: Set<string>, removedId: string, repeatAll: boolean): Track | null {
  const index = display.findIndex(track => track.id === removedId)
  if (index >= 0) {
    for (let cursor = index + 1; cursor < display.length; cursor += 1) {
      if (allowedIds.has(display[cursor].id)) return display[cursor]
    }
  }
  if (!repeatAll) return null
  return display.find(track => track.id !== removedId && allowedIds.has(track.id)) ?? null
}

/** Natural end differs from the user explicitly pressing Next. */
export function trackEndAction(mode: 'none' | 'all' | 'one', autoPlay: boolean, length: number, index: number): 'stop' | 'replay' | number {
  if (mode === 'one') return 'replay'
  if (!autoPlay || length === 0) return 'stop'
  const next = index + 1
  if (next < length) return Math.max(0, next)
  return mode === 'all' ? 0 : 'stop'
}
