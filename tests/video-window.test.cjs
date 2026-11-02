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

const video = load('src/services/videoWindowSource.ts')

test('small window prefers an H.264 480p stream', () => {
  const url = video.pickSmallVideoUrl([
    { codecid: 12, quality: 80, bandwidth: 900, baseUrl: 'https://cdn.example/hevc' },
    { codecid: 7, quality: 116, bandwidth: 4000, baseUrl: 'https://cdn.example/4k' },
    { codecid: 7, quality: 32, bandwidth: 500, baseUrl: 'https://cdn.example/480' },
    { codecid: 7, quality: 64, bandwidth: 800, baseUrl: 'https://cdn.example/720' },
  ])
  assert.equal(url, 'https://cdn.example/480')
})

test('a part does not reuse another part of the same video', () => {
  video.rememberSmallVideo('BV1test0001', 11, [{ codecid: 7, quality: 32, baseUrl: 'https://cdn.example/p1' }])
  video.rememberSmallVideo('BV1test0001', 22, [{ codecid: 7, quality: 32, baseUrl: 'https://cdn.example/p2' }])
  assert.equal(video.recallSmallVideo('BV1test0001', 11), 'https://cdn.example/p1')
  assert.equal(video.recallSmallVideo('BV1test0001', 33), null)
})

test('small window reads the dash id and keeps a 1080p stream', () => {
  const picked = video.describeSmallVideo([
    { codecid: 7, id: 16, bandwidth: 5000, baseUrl: 'https://cdn.example/360' },
    { codecid: 7, id: 32, bandwidth: 400, baseUrl: 'https://cdn.example/480' },
    { codecid: 7, id: 80, bandwidth: 200, height: 1080, baseUrl: 'https://cdn.example/1080' },
  ], 1080)
  assert.equal(picked.url, 'https://cdn.example/1080')
  assert.equal(picked.pixels, 1080)
  const fallback = video.describeSmallVideo([
    { codecid: 7, id: 16, bandwidth: 900, baseUrl: 'https://cdn.example/360' },
    { codecid: 7, id: 80, bandwidth: 200, baseUrl: 'https://cdn.example/1080' },
  ], 480)
  assert.equal(fallback.url, 'https://cdn.example/360')
  assert.equal(fallback.pixels, 360)
})

test('small window ignores streams that are not https', () => {
  assert.equal(video.pickSmallVideoUrl([{ codecid: 7, quality: 32, baseUrl: 'http://cdn.example/480' }]), null)
  assert.equal(video.pickSmallVideoUrl([]), null)
})
