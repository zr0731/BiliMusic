const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

function load(file) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const exports = {}
  // Run in this realm so returned objects and arrays compare with assert.deepEqual.
  const runner = vm.runInThisContext(
    `(function (exports, require, console, AbortController, AbortSignal) {\n${source}\n})`,
    { filename: file },
  )
  runner(exports, require, console, AbortController, AbortSignal)
  return exports
}

const batch = load('src/services/biliBatchSource.ts')

test('batch links identify a video, uploader, favorite, or one collection', () => {
  assert.deepEqual(batch.parseBatchSource('BV1A14y1n7Sk'), { kind: 'video', bvid: 'BV1A14y1n7Sk', entry: 'bvid' })
  assert.deepEqual(batch.parseBatchSource('https://www.bilibili.com/video/BV1A14y1n7Sk?p=3'), { kind: 'video', bvid: 'BV1A14y1n7Sk', entry: 'page' })
  assert.deepEqual(batch.parseBatchSource('https://space.bilibili.com/37754047'), { kind: 'uploader', mid: 37754047 })
  assert.deepEqual(batch.parseBatchSource('https://space.bilibili.com/37754047/video'), { kind: 'uploader', mid: 37754047 })
  assert.deepEqual(
    batch.parseBatchSource('https://www.bilibili.com/list/525333679/?spm_id_from=333.1387.0.0&sort_field=pubtime&tid=0&oid=115966600024077&bvid=BV1vJ6gBDETY'),
    { kind: 'video', bvid: 'BV1vJ6gBDETY', entry: 'bvid' },
  )
  assert.throws(() => batch.parseBatchSource('https://www.bilibili.com/list/525333679/'), /空间页/)
  assert.deepEqual(
    batch.parseBatchSource('https://space.bilibili.com/350095579/favlist?fid=3669560679&ftype=create'),
    { kind: 'favorite', mediaId: 3669560679 },
  )
  assert.deepEqual(
    batch.parseBatchSource('https://space.bilibili.com/2004128307/lists/8899?type=season'),
    { kind: 'season', mid: 2004128307, seasonId: 8899 },
  )
  assert.deepEqual(
    batch.parseBatchSource('https://space.bilibili.com/2004128307/lists/8899?type=series'),
    { kind: 'series', mid: 2004128307, seriesId: 8899 },
  )
  assert.throws(() => batch.parseBatchSource('https://space.bilibili.com/2004128307/lists'), /合集目录/)
  assert.throws(() => batch.parseBatchSource('https://space.bilibili.com/350095579/favlist'), /fid/)
})

test('each video page becomes its own track and keeps that page duration', () => {
  const pages = Array.from({ length: 100 }, (_, index) => ({ cid: 1000 + index, part: `曲目${index + 1}`, duration: 180 }))
  const tracks = batch.tracksFromDetail({
    bvid: 'BV1A14y1n7Sk', aid: 1, title: '一百首', pic: 'http://i0.hdslb.com/cover.jpg', ownerName: 'UP',
    duration: 18000, cid: 1000, view: 9, pages,
  })
  assert.equal(tracks.length, 100)
  assert.equal(tracks[0].id, 'BV1A14y1n7Sk:1000')
  assert.equal(tracks[0].title, '曲目1')
  assert.equal(tracks[0].album, '一百首')
  assert.equal(tracks[0].duration, 180)
  assert.equal(tracks[99].cid, 1099)
  assert.equal(batch.pageCidOf(tracks[3]), 1003)
  const single = batch.tracksFromDetail({
    bvid: 'BV1xxxxxxxxx', aid: 2, title: '单曲', pic: '', ownerName: 'UP', duration: 200, cid: 7, view: 0,
    pages: [{ cid: 7, part: '单曲', duration: 200 }],
  })
  assert.equal(single.length, 1)
  assert.equal(single[0].id, 'BV1xxxxxxxxx')
  assert.equal(single[0].title, '单曲')
  assert.equal(batch.pageCidOf(single[0]), undefined)
})

test('uploader import walks every listed video and skips one that cannot be read', async () => {
  const seenPages = []
  const client = {
    async videos(_source, page) {
      seenPages.push(page)
      if (page === 1) return { bvids: ['BV1000000001'], total: 2, pageSize: 1, received: 1 }
      return { bvids: ['BV1000000002'], total: 2, pageSize: 1, received: 1 }
    },
    async video(bvid) {
      if (bvid === 'BV1000000002') throw new Error('missing')
      return {
        bvid, aid: 3, title: '两首', pic: '', ownerName: '甲', duration: 9, cid: 1, view: 0,
        pages: [{ cid: 1, part: '前', duration: 4 }, { cid: 2, part: '后', duration: 5 }],
      }
    },
  }
  const result = await batch.collectBatchTracks({ kind: 'uploader', mid: 1 }, client)
  assert.deepEqual(seenPages, [1, 2])
  assert.equal(result.failed, 1)
  assert.equal(result.tracks.length, 2)
  assert.deepEqual(result.tracks.map(track => track.duration), [4, 5])
})

test('a video page in a collection asks, a bare BV does not, and import stays on that video', async () => {
  const detail = {
    bvid: 'BV1UbrKYkEzs', aid: 1, title: '百万个吻', pic: '', ownerName: '真栗',
    duration: 1, cid: 1, view: 0, pages: [{ cid: 1, part: '', duration: 1 }],
    season: { mid: 2004128307, seasonId: 5398600, title: 'Ban位×整活', count: 20 },
  }
  const page = batch.parseBatchSource('https://www.bilibili.com/video/BV1UbrKYkEzs/?spm_id_from=333.1387.collection.video_card.click&vd_source=1')
  assert.equal(batch.collectionChoice({ kind: 'video', bvid: 'BV1UbrKYkEzs', entry: 'bvid' }, detail), null)
  assert.deepEqual(batch.collectionChoice(page, detail).season, {
    mid: 2004128307, seasonId: 5398600, title: 'Ban位×整活', count: 20,
  })
  const calls = []
  const result = await batch.collectBatchTracks(page, {
    async video(bvid) {
      calls.push(bvid)
      return detail
    },
    async videos() {
      throw new Error('should not list the collection')
    },
  })
  assert.deepEqual(calls, ['BV1UbrKYkEzs'])
  assert.deepEqual(result.tracks.map(track => track.bvid), ['BV1UbrKYkEzs'])
})
