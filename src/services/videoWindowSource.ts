export interface VideoCandidate {
  id?: number
  codecid?: number
  quality?: number
  bandwidth?: number
  width?: number
  height?: number
  baseUrl?: string
  base_url?: string
}

const remembered = new Map<string, { videos: VideoCandidate[]; at: number }>()
const descriptions = new Map<string, string>()
const REMEMBER_MS = 10 * 60 * 1000

/** 播放时已经拿到的简介，歌词匹配用来读歌手、作词、作曲，不再单独多等一次。 */
export function rememberVideoDesc(bvid: string, desc: string) {
  if (bvid) descriptions.set(bvid, desc || '')
}

export function recallVideoDesc(bvid: string): string | null {
  return descriptions.has(bvid) ? descriptions.get(bvid) || '' : null
}

function streamUrl(item: VideoCandidate): string {
  const url = item.baseUrl || item.base_url || ''
  return typeof url === 'string' && url.startsWith('https://') ? url : ''
}

/** 播放取音频时顺手记下小窗地址，打开小窗就不用再等一次接口。 */
export function rememberSmallVideo(bvid: string, cid: number, videos: VideoCandidate[] | null | undefined) {
  const list = (videos || []).filter(item => streamUrl(item))
  if (!list.length || !bvid) return
  const at = Date.now()
  remembered.set(`${bvid}:${cid}`, { videos: list, at })
  remembered.set(bvid, { videos: list, at })
}

export function recallSmallVideo(bvid: string, cid?: number, prefer: 480 | 720 | 1080 = 480): string | null {
  return recallSmallVideoInfo(bvid, cid, prefer)?.url || null
}

export function recallSmallVideoInfo(
  bvid: string,
  cid: number | undefined,
  prefer: 480 | 720 | 1080 = 480,
): { url: string; pixels: number } | null {
  // 指定了分 P 就只认这一 P。退回整支视频的缓存时，会把上一 P 的画面套到当前这首上。
  const key = cid ? `${bvid}:${cid}` : bvid
  const hit = remembered.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > REMEMBER_MS) {
    remembered.delete(key)
    return null
  }
  return describeSmallVideo(hit.videos, prefer)
}

/** B 站 DASH 的清晰度在 id 上，不在 quality。高度能对上时以高度为准。认不出时返回 0，不当成 360p。 */
function pixelsOf(item: VideoCandidate): number {
  const height = Number(item.height) || 0
  if (height >= 1000) return 1080
  if (height >= 700) return 720
  if (height >= 450) return 480
  if (height >= 300) return 360
  const id = Number(item.id ?? item.quality)
  if (!Number.isFinite(id) || id <= 0) return 0
  if (id <= 16) return 360
  if (id <= 32) return 480
  if (id <= 74) return 720
  return 1080
}

/** 小窗优先 H.264。按设置的清晰度就近选，避免 4K 和播不了的 HEVC。pixels 是实际选中的档。 */
export function describeSmallVideo(
  videos: VideoCandidate[] | null | undefined,
  prefer: 480 | 720 | 1080 = 480,
): { url: string; pixels: number } | null {
  const list = (videos || []).filter(item => streamUrl(item))
  const h264 = list.filter(item => item.codecid === 7)
  const pool = h264.length > 0 ? h264 : list
  if (pool.length === 0) return null
  const distance = (item: VideoCandidate) => {
    const pixels = pixelsOf(item)
    if (pixels <= 0) return 10000
    return Math.abs(pixels - prefer) + (pixels > prefer ? 80 : 0)
  }
  pool.sort((a, b) => distance(a) - distance(b) || (b.bandwidth || 0) - (a.bandwidth || 0))
  const best = pool[0]
  const url = streamUrl(best)
  if (!url) return null
  return { url, pixels: pixelsOf(best) }
}

export function pickSmallVideoUrl(videos: VideoCandidate[] | null | undefined, prefer: 480 | 720 | 1080 = 480): string | null {
  return describeSmallVideo(videos, prefer)?.url || null
}
