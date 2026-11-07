import { probeTrack } from '@/services/unavailableLibrary'
import { inspectAvailability, type UnavailableItem } from '@/services/unavailableTracks'
import type { Track } from '@/types'
import { readStoredItem, writeStoredItem } from '@/utils/persistentStorage'

export interface CheckSnapshot {
  phase: 'idle' | 'running' | 'done'
  done: number
  total: number
  finishedAt: number | null
  report: { gone: UnavailableItem[]; temporary: UnavailableItem[] } | null
  emptyNote: string
}

interface CheckJob extends CheckSnapshot {
  key: string
  runId: number
  tracks: Track[]
  scopeLabel: string
  publishedAt: number
  snapshot?: CheckSnapshot
}

const jobs = new Map<string, CheckJob>()
const idle = new Map<string, CheckSnapshot>()
const listeners = new Map<string, Set<() => void>>()

function checkedKey(scopeKey: string) {
  return `bilimusic_unavailable_checked_at:${scopeKey}`
}

function readCheckedAt(scopeKey: string): number | null {
  try {
    const value = Number(readStoredItem(checkedKey(scopeKey)) || 0)
    return value > 0 ? value : null
  } catch {
    return null
  }
}

function writeCheckedAt(scopeKey: string, now: number) {
  try {
    writeStoredItem(checkedKey(scopeKey), String(now))
  } catch {
    // 记不住时间时，这次检查的结果仍然要能看。
  }
}

function publish(job: CheckJob) {
  job.snapshot = {
    phase: job.phase,
    done: job.done,
    total: job.total,
    finishedAt: job.finishedAt,
    report: job.report,
    emptyNote: job.emptyNote,
  }
  listeners.get(job.key)?.forEach(listener => listener())
}

export function subscribeCheck(scopeKey: string, listener: () => void) {
  let set = listeners.get(scopeKey)
  if (!set) listeners.set(scopeKey, set = new Set())
  set.add(listener)
  return () => set!.delete(listener)
}

export function getCheckSnapshot(scopeKey: string): CheckSnapshot {
  const job = jobs.get(scopeKey)
  if (job) {
    const current = job.snapshot
    if (current && current.done === job.done && current.total === job.total && current.phase === job.phase && current.finishedAt === job.finishedAt && current.emptyNote === job.emptyNote && current.report === job.report) {
      return current
    }
    const next: CheckSnapshot = {
      phase: job.phase,
      done: job.done,
      total: job.total,
      finishedAt: job.finishedAt,
      report: job.report,
      emptyNote: job.emptyNote,
    }
    job.snapshot = next
    return next
  }
  const finishedAt = readCheckedAt(scopeKey)
  const cached = idle.get(scopeKey)
  if (cached && cached.finishedAt === finishedAt) return cached
  const snapshot: CheckSnapshot = { phase: 'idle', done: 0, total: 0, finishedAt, report: null, emptyNote: '' }
  idle.set(scopeKey, snapshot)
  return snapshot
}

export function dismissCheckReport(scopeKey: string) {
  const job = jobs.get(scopeKey)
  if (!job) return
  job.report = null
  job.emptyNote = ''
  publish(job)
}

export function startUnavailableCheck(scopeKey: string, tracks: Track[], scopeLabel: string) {
  const current = jobs.get(scopeKey)
  if (current?.phase === 'running' || tracks.length === 0) return
  const runId = (current?.runId ?? 0) + 1
  const job: CheckJob = {
    key: scopeKey,
    runId,
    tracks,
    scopeLabel,
    phase: 'running',
    done: 0,
    total: tracks.length,
    finishedAt: current?.finishedAt ?? readCheckedAt(scopeKey),
    report: null,
    emptyNote: '',
    publishedAt: 0,
    snapshot: undefined,
  }
  jobs.set(scopeKey, job)
  publish(job)
  const entries = tracks.map(track => ({ track, places: [scopeLabel] }))
  void inspectAvailability(entries, probeTrack, {
    concurrency: 1,
    gapMs: 80,
    isCancelled: () => job.runId !== runId,
    onProgress: (done, total) => {
      if (job.runId !== runId) return
      job.done = done
      job.total = total
      const watching = (listeners.get(job.key)?.size ?? 0) > 0
      const now = Date.now()
      if (!watching || (done !== total && now - job.publishedAt < 500)) return
      job.publishedAt = now
      publish(job)
    },
  }).then(result => {
    if (job.runId !== runId) return
    finish(job, Date.now(), result)
  }).catch(() => {
    if (job.runId !== runId) return
    finish(job, Date.now(), {
      gone: [],
      temporary: tracks.filter(track => /^BV[0-9A-Za-z]{10}$/.test(track.bvid || '')).map(track => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        bvid: track.bvid,
        reason: '网络失败',
        places: [scopeLabel],
      })),
    })
  })
}

function finish(job: CheckJob, now: number, result: { gone: UnavailableItem[]; temporary: UnavailableItem[] } | null) {
  job.phase = 'done'
  job.finishedAt = now
  writeCheckedAt(job.key, now)
  if (!result || (result.gone.length === 0 && result.temporary.length === 0)) {
    job.report = null
    job.emptyNote = '没有失效曲目'
  } else {
    job.report = result
    job.emptyNote = ''
  }
  publish(job)
}
