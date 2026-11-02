export type UnavailableCheckMode = 'off' | 'launch' | 'weekly'

export interface UnavailableVerdict {
  kind: 'gone' | 'temporary'
  reason: string
}

export interface InspectableTrack {
  id: string
  title: string
  artist: string
  bvid: string
}

export interface UnavailableItem {
  id: string
  title: string
  artist: string
  bvid: string
  reason: string
  places: string[]
}

const GONE_REASONS: Record<number, string> = {
  [-404]: '稿件不存在',
  [62002]: '稿件不可见',
}

const TEMPORARY_REASONS: Record<number, string> = {
  [-400]: '请求没有完成',
  [-403]: '当前账号看不了，稿件还在',
  [-412]: '请求被拦截',
  [-352]: '请求被拦截',
  [-509]: '请求过于频繁',
  [-799]: '请求被拦截',
  [62004]: '稿件还在审核',
  [62012]: '稿件仅自己可见',
}

export function classifyViewCode(code: number): UnavailableVerdict {
  if (GONE_REASONS[code]) return { kind: 'gone', reason: GONE_REASONS[code] }
  if (TEMPORARY_REASONS[code]) return { kind: 'temporary', reason: TEMPORARY_REASONS[code] }
  return { kind: 'temporary', reason: `暂时无法确认（${code}）` }
}

export function classifyThrown(error: unknown): UnavailableVerdict {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'number') {
    return classifyViewCode((error as { code: number }).code)
  }
  if (error instanceof Error && /No audio stream available/.test(error.message)) {
    return { kind: 'gone', reason: '已经没有可播放的音频' }
  }
  return { kind: 'temporary', reason: '网络失败' }
}

const DAY = 24 * 60 * 60 * 1000

export function shouldRunUnavailableCheck(mode: UnavailableCheckMode, lastAt: number | null, now: number): boolean {
  if (mode === 'off') return false
  if (!lastAt || !Number.isFinite(lastAt)) return true
  if (mode === 'weekly') return now - lastAt >= 7 * DAY
  const previous = new Date(lastAt)
  const current = new Date(now)
  return previous.getFullYear() !== current.getFullYear()
    || previous.getMonth() !== current.getMonth()
    || previous.getDate() !== current.getDate()
}

export async function inspectAvailability(
  entries: Array<{ track: InspectableTrack; places: string[] }>,
  probe: (track: InspectableTrack) => Promise<'ok' | UnavailableVerdict>,
  hooks: { concurrency?: number; isCancelled?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ gone: UnavailableItem[]; temporary: UnavailableItem[] } | null> {
  const unique: Array<{ track: InspectableTrack; places: string[] }> = []
  const indexById = new Map<string, number>()
  for (const entry of entries) {
    const id = entry.track.id
    const known = indexById.get(id)
    if (known !== undefined) {
      for (const place of entry.places) {
        if (!unique[known].places.includes(place)) unique[known].places.push(place)
      }
      continue
    }
    indexById.set(id, unique.length)
    unique.push({ track: entry.track, places: [...entry.places] })
  }

  const gone: UnavailableItem[] = []
  const temporary: UnavailableItem[] = []
  let cursor = 0
  let done = 0
  const limit = Math.max(1, Math.min(hooks.concurrency ?? 3, unique.length || 1))

  const run = async () => {
    while (cursor < unique.length) {
      if (hooks.isCancelled?.()) return
      const entry = unique[cursor]
      cursor += 1
      const verdict = await probe(entry.track)
      done += 1
      hooks.onProgress?.(done, unique.length)
      if (hooks.isCancelled?.()) return
      if (verdict === 'ok') continue
      const item: UnavailableItem = {
        id: entry.track.id,
        title: entry.track.title,
        artist: entry.track.artist,
        bvid: entry.track.bvid,
        reason: verdict.reason,
        places: entry.places,
      }
      if (verdict.kind === 'gone') gone.push(item)
      else temporary.push(item)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()))
  if (hooks.isCancelled?.()) return null
  return { gone, temporary }
}
