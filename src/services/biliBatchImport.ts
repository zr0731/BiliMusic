import { getFavoriteResources, getSeasonArchives, getSeriesArchives, getUserVideos, getVideoDetail } from '@/services/bilibiliApi'
import {
  collectBatchTracks,
  type BatchClient,
  type BatchPage,
  type BatchProgress,
  type BatchSource,
  type BatchVideoDetail,
} from '@/services/biliBatchSource'

const LIST_SIZE = 20

function pageOf(items: Array<{ bvid?: string }>, total: number, pageSize: number): BatchPage {
  return {
    bvids: items.map(item => item.bvid || '').filter(Boolean),
    total,
    pageSize,
    received: items.length,
  }
}

const client: BatchClient = {
  async video(bvid: string): Promise<BatchVideoDetail> {
    const detail = await getVideoDetail(bvid)
    return {
      bvid: detail.bvid,
      aid: detail.aid,
      title: detail.title,
      pic: detail.pic,
      ownerName: detail.owner?.name || '',
      duration: detail.duration,
      cid: detail.cid,
      view: detail.stat?.view || 0,
      pages: (detail.pages || []).map(page => ({ cid: page.cid, part: page.part || '', duration: page.duration || 0 })),
      season: detail.ugc_season?.id && detail.ugc_season.mid
        ? {
            mid: detail.ugc_season.mid,
            seasonId: detail.ugc_season.id,
            title: detail.ugc_season.title || '',
            count: detail.ugc_season.ep_count || 0,
          }
        : null,
    }
  },
  async videos(source: Exclude<BatchSource, { kind: 'video' }>, page: number): Promise<BatchPage> {
    if (source.kind === 'uploader') {
      const data = await getUserVideos(source.mid, page, 30)
      return pageOf(data.list?.vlist || [], data.page?.count || 0, 30)
    }
    if (source.kind === 'favorite') {
      const data = await getFavoriteResources(source.mediaId, page, LIST_SIZE)
      const medias = data.medias || []
      return pageOf(medias, data.info?.media_count || 0, LIST_SIZE)
    }
    if (source.kind === 'season') {
      const data = await getSeasonArchives(source.mid, source.seasonId, page, 30)
      return pageOf(data.archives || [], data.page?.total || 0, 30)
    }
    const data = await getSeriesArchives(source.mid, source.seriesId, page, 30)
    return pageOf(data.archives || [], data.page?.total || 0, 30)
  },
}

export function previewBatchVideo(bvid: string) {
  return client.video(bvid)
}

export function importBatchSource(
  source: BatchSource,
  options: { signal?: AbortSignal; onProgress?: (progress: BatchProgress) => void } = {},
) {
  return collectBatchTracks(source, client, options)
}
