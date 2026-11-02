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
  const runner = vm.runInThisContext(
    `(function (exports, require, console) {\n${source}\n})`,
    { filename: file },
  )
  runner(exports, require, console)
  return exports
}

const checker = load('src/services/unavailableTracks.ts')

test('a missing manuscript can be removed, a network failure cannot', () => {
  assert.deepEqual(checker.classifyViewCode(-404), { kind: 'gone', reason: '稿件不存在' })
  assert.deepEqual(checker.classifyViewCode(62002), { kind: 'gone', reason: '稿件不可见' })
  assert.equal(checker.classifyViewCode(-412).kind, 'temporary')
  assert.equal(checker.classifyThrown(new Error('Failed to fetch')).reason, '网络失败')
  assert.equal(checker.classifyThrown({ code: -403 }).kind, 'temporary')
})

test('opening the app checks at most once per local day, weekly waits seven days', () => {
  const monday = Date.parse('2026-03-02T08:00:00')
  const later = Date.parse('2026-03-02T21:00:00')
  const nextDay = Date.parse('2026-03-03T00:10:00')
  assert.equal(checker.shouldRunUnavailableCheck('off', null, monday), false)
  assert.equal(checker.shouldRunUnavailableCheck('launch', null, monday), true)
  assert.equal(checker.shouldRunUnavailableCheck('launch', monday, later), false)
  assert.equal(checker.shouldRunUnavailableCheck('launch', monday, nextDay), true)
  assert.equal(checker.shouldRunUnavailableCheck('weekly', monday, nextDay), false)
  assert.equal(checker.shouldRunUnavailableCheck('weekly', monday, monday + 7 * 24 * 60 * 60 * 1000), true)
})

test('inspection keeps network failures out of the removal list', async () => {
  const tracks = [
    { id: 'gone', title: '不见了', artist: '甲', bvid: 'BV1gone00001' },
    { id: 'net', title: '网络', artist: '乙', bvid: 'BV1net000001' },
    { id: 'ok', title: '还在', artist: '丙', bvid: 'BV1ok0000001' },
  ]
  const result = await checker.inspectAvailability(
    tracks.map(track => ({ track, places: ['歌单「测试」'] })),
    async (track) => {
      if (track.id === 'gone') return { kind: 'gone', reason: '稿件不存在' }
      if (track.id === 'net') return { kind: 'temporary', reason: '网络失败' }
      return 'ok'
    },
  )
  assert.deepEqual(result.gone.map(item => item.id), ['gone'])
  assert.deepEqual(result.temporary.map(item => item.reason), ['网络失败'])
})
