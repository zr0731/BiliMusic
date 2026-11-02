import type { Track } from '@/types'

export type BatchSource =
  | { kind: 'video'; bvid: string; entry: 'bvid' | 'page' }
  | { kind: 'uploader'; mid: number }
  | { kind: 'favorite'; mediaId: number }
  | { kind: 'season'; mid: number; seasonId: number }
  | { kind: 'series'; mid: number; seriesId: number }

export class BatchSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BatchSourceError'
  }
}

export interface BatchVideoDetail {
  bvid: string
  aid: number
  title: string
  pic: string
  ownerName: string
  duration: number
  cid: number
  view: number
  pages: { cid: number; part: string; duration: number }[]
  season?: { mid: number; seasonId: number; title?: string; count?: number } | null
}

/** 视频页属于合集时先问用户。只贴 BV 号不问，合集自己的地址也不走这里。 */
export interface CollectionChoice {
  bvid: string
  videoTitle: string
  season: { mid: number; seasonId: number; title: string; count: number }
}

export interface BatchPage {
  bvids: string[]
  total: number
  pageSize: number
  received: number
}

export interface BatchClient {
  video(bvid: string): Promise<BatchVideoDetail>
  videos(source: Exclude<BatchSource, { kind: 'video' }>, page: number): Promise<BatchPage>
}

export interface BatchProgress {
  phase: 'list' | 'split'
  done: number
  total: number
}

export interface BatchCollectResult {
  tracks: Track[]
  failed: number
  cancelled: boolean
}

const BV_ID = /^BV[0-9A-Za-z]{10}$/
const LIST_PAGE_CAP = 500

function coverUrl(url: string): string {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('http://')) return `https://${url.slice(7)}`
  return url
}

function positiveId(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function asUrl(text: string): URL | null {
  try {
    return new URL(text.includes('://') ? text : `https://${text}`)
  } catch {
    return null
  }
}

/** 分 P 曲目的 id 带上 cid。只有这种 id 在播放时才锁定到对应分 P。 */
export function pageCidOf(track: { id: string; bvid?: string; cid?: string | number }): string | number | undefined {
  if (!track.bvid || track.cid == null || track.cid === '') return undefined
  return track.id === `${track.bvid}:${track.cid}` ? track.cid : undefined
}

export function parseBatchSource(raw: string): BatchSource {
  const text = raw.trim()
  if (!text) throw new BatchSourceError('请贴上 BV 号或 B 站链接')
  if (BV_ID.test(text)) return { kind: 'video', bvid: text, entry: 'bvid' }
  if (/^av\d+$/i.test(text)) throw new BatchSourceError('请换成 BV 号或带 BV 的视频网址')

  const url = asUrl(text)
  if (!url) throw new BatchSourceError('认不出这个链接。可以贴视频、UP 主空间、带 fid 的收藏夹，或某一个合集的链接')

  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  if (host === 'b23.tv') throw new BatchSourceError('短链接请先在浏览器打开，再复制打开后的地址')
  if (/\/video\/av\d+/i.test(url.pathname)) throw new BatchSourceError('请换成 BV 号或带 BV 的视频网址')

  if (host === 'bilibili.com' || host === 'm.bilibili.com') {
    const video = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/)
    if (video) return { kind: 'video', bvid: video[1], entry: 'page' }
    const media = url.pathname.match(/\/medialist\/(?:detail|play)\/ml(\d+)/)
    const mediaId = media ? positiveId(media[1]) : null
    if (mediaId) return { kind: 'favorite', mediaId }
    const listMid = url.pathname.match(/\/list\/(\d+)/)
    const mid = listMid ? positiveId(listMid[1]) : null
    const sid = positiveId(url.searchParams.get('sid'))
    const businessId = positiveId(url.searchParams.get('business_id'))
    const business = url.searchParams.get('business')
    if (mid && business === 'space_series' && businessId) return { kind: 'series', mid, seriesId: businessId }
    if (mid && sid) return { kind: 'season', mid, seasonId: sid }
    if (mid && businessId) return { kind: 'season', mid, seasonId: businessId }
    if (mid) {
      const listed = url.searchParams.get('bvid')?.match(/BV[0-9A-Za-z]{10}/)
      if (listed) return { kind: 'video', bvid: listed[0], entry: 'bvid' }
      throw new BatchSourceError('这个列表地址只代表当前打开的一个视频，但里面没有 BV 号。要加入 UP 主的全部投稿，请改用空间页链接')
    }
  }

  if (host === 'space.bilibili.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    const mid = positiveId(parts[0])
    if (!mid) throw new BatchSourceError('空间链接里没有 UP 主的 uid')
    const fid = positiveId(url.searchParams.get('fid'))
    if (fid) return { kind: 'favorite', mediaId: fid }
    if (parts[1] === 'favlist') throw new BatchSourceError('收藏夹链接需要带上 fid。打开某一个收藏夹后再复制地址')
    if (parts[1] === 'lists') {
      const listId = positiveId(parts[2])
      if (!listId) throw new BatchSourceError('这是合集目录。打开某一个合集后再复制链接')
      if (url.searchParams.get('type') === 'series') return { kind: 'series', mid, seriesId: listId }
      return { kind: 'season', mid, seasonId: listId }
    }
    if (parts[1] === 'channel' && parts[2] === 'collectiondetail') {
      const sid = positiveId(url.searchParams.get('sid'))
      if (!sid) throw new BatchSourceError('这是合集目录。打开某一个合集后再复制链接')
      return { kind: 'season', mid, seasonId: sid }
    }
    if (parts[1] === 'channel' && parts[2] === 'seriesdetail') {
      const sid = positiveId(url.searchParams.get('sid'))
      if (!sid) throw new BatchSourceError('请打开某一个系列后再复制链接')
      return { kind: 'series', mid, seriesId: sid }
    }
    return { kind: 'uploader', mid }
  }

  throw new BatchSourceError('认不出这个链接。可以贴视频、UP 主空间、带 fid 的收藏夹，或某一个合集的链接')
}

export function tracksFromDetail(detail: BatchVideoDetail): Track[] {
  const pages = detail.pages.filter(page => page.cid)
  const usable = pages.length > 0 ? pages : [{ cid: detail.cid, part: '', duration: detail.duration }]
  const multi = usable.length > 1
  return usable.map((page, index) => {
    const part = page.part.trim()
    const title = !multi
      ? detail.title
      : part && part !== detail.title
        ? part
        : `${detail.title} · P${index + 1}`
    return {
      id: multi ? `${detail.bvid}:${page.cid}` : detail.bvid,
      title,
      album: multi ? detail.title : undefined,
      artist: detail.ownerName,
      coverUrl: coverUrl(detail.pic),
      duration: page.duration || (multi ? 0 : detail.duration),
      videoUrl: `https://www.bilibili.com/video/${detail.bvid}${multi ? `?p=${index + 1}` : ''}`,
      bvid: detail.bvid,
      aid: detail.aid,
      cid: page.cid,
      playCount: detail.view || 0,
      isLiked: false,
    }
  })
}

function takeBvids(batch: BatchPage, seen: Set<string>, bvids: string[]) {
  const before = bvids.length
  for (const bvid of batch.bvids) {
    if (!bvid || seen.has(bvid)) continue
    seen.add(bvid)
    bvids.push(bvid)
  }
  return bvids.length === before
}

async function listBvids(source: BatchSource, client: BatchClient, signal: AbortSignal, onProgress?: (progress: BatchProgress) => void): Promise<{ bvids: string[]; cancelled: boolean }> {
  if (source.kind === 'video') return { bvids: [source.bvid], cancelled: false }
  const bvids: string[] = []
  const seen = new Set<string>()
  if (signal.aborted) return { bvids, cancelled: true }
  const first = await client.videos(source, 1)
  const total = first.total
  const stopped = first.bvids.length === 0 && first.received === 0
  if (!stopped) takeBvids(first, seen, bvids)
  onProgress?.({ phase: 'list', done: bvids.length, total: total || bvids.length })
  const pageDone = stopped || (total > 0 && bvids.length >= total) || first.received < first.pageSize
  if (!pageDone && total > 0 && first.pageSize > 0) {
    const pages = Math.min(LIST_PAGE_CAP, Math.ceil(total / first.pageSize))
    const rest: Array<BatchPage | undefined> = []
    let cursor = 2
    const workers = Array.from({ length: Math.min(3, Math.max(0, pages - 1)) }, async () => {
      while (cursor <= pages) {
        if (signal.aborted) return
        const page = cursor
        cursor += 1
        rest[page] = await client.videos(source, page)
      }
    })
    await Promise.all(workers)
    for (let page = 2; page <= pages; page += 1) {
      const batch = rest[page]
      if (!batch) break
      const addedNothing = takeBvids(batch, seen, bvids)
      onProgress?.({ phase: 'list', done: bvids.length, total: total || bvids.length })
      if (addedNothing || batch.received < batch.pageSize) break
    }
  } else if (!pageDone) {
    for (let page = 2; page <= LIST_PAGE_CAP; page += 1) {
      if (signal.aborted) return { bvids, cancelled: true }
      const batch = await client.videos(source, page)
      if (batch.bvids.length === 0 && batch.received === 0) break
      const addedNothing = takeBvids(batch, seen, bvids)
      onProgress?.({ phase: 'list', done: bvids.length, total: total || bvids.length })
      if (addedNothing || batch.received < batch.pageSize) break
    }
  }
  return { bvids, cancelled: signal.aborted }
}

export function collectionChoice(source: BatchSource, detail: BatchVideoDetail): CollectionChoice | null {
  if (source.kind !== 'video' || source.entry !== 'page') return null
  const season = detail.season
  if (!season || !Number.isSafeInteger(season.mid) || season.mid <= 0) return null
  if (!Number.isSafeInteger(season.seasonId) || season.seasonId <= 0) return null
  const rawCount = season.count ?? 0
  return {
    bvid: source.bvid,
    videoTitle: detail.title,
    season: {
      mid: season.mid,
      seasonId: season.seasonId,
      title: season.title?.trim() || '这个合集',
      count: Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 0,
    },
  }
}

export async function collectBatchTracks(
  source: BatchSource,
  client: BatchClient,
  options: { signal?: AbortSignal; onProgress?: (progress: BatchProgress) => void } = {},
): Promise<BatchCollectResult> {
  const signal = options.signal ?? new AbortController().signal
  if (source.kind === 'video') {
    if (signal.aborted) return { tracks: [], failed: 0, cancelled: true }
    const detail = await client.video(source.bvid)
    if (signal.aborted) return { tracks: [], failed: 0, cancelled: true }
    options.onProgress?.({ phase: 'split', done: 1, total: 1 })
    return { tracks: tracksFromDetail(detail), failed: 0, cancelled: false }
  }
  const listed = await listBvids(source, client, signal, options.onProgress)
  const groups: Track[][] = new Array(listed.bvids.length)
  let failed = 0
  let done = 0
  let cursor = 0
  const workers = Array.from({ length: Math.min(3, listed.bvids.length) }, async () => {
    while (cursor < listed.bvids.length) {
      if (signal.aborted) return
      const index = cursor
      cursor += 1
      const bvid = listed.bvids[index]
      try {
        groups[index] = tracksFromDetail(await client.video(bvid))
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return
        groups[index] = []
        failed += 1
      }
      done += 1
      options.onProgress?.({ phase: 'split', done, total: listed.bvids.length })
    }
  })
  await Promise.all(workers)
  return {
    tracks: groups.flat().filter(Boolean),
    failed,
    cancelled: signal.aborted || listed.cancelled,
  }
}
