import { app, ipcMain, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { assertTrustedSender, validateAudioUrl } from './security'

const cache = new Map<string, number>()
const TARGET_LUFS = -16
const MAX_SHIFT_DB = 12

function ffmpegBinary(): string {
  if (!ffmpegStatic) throw new Error('没有 FFmpeg')
  return ffmpegStatic.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

async function readSample(url: string, file: string): Promise<void> {
  const response = await net.fetch(url, {
    headers: { Referer: 'https://www.bilibili.com/' },
    credentials: 'omit',
  })
  if (!response.ok || !response.body) throw new Error('读不到音频开头')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  while (size < 2_400_000) {
    const step = await reader.read()
    if (step.done) break
    chunks.push(Buffer.from(step.value))
    size += step.value.byteLength
  }
  await reader.cancel().catch(() => {})
  await fs.writeFile(file, Buffer.concat(chunks))
}

function integratedLoudness(file: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary(), [
      '-hide_banner', '-nostdin', '-t', '24', '-i', file,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-',
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let log = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('测音量超时')) }, 20_000)
    child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', () => {
      clearTimeout(timer)
      const integrated = log.match(/"input_i"\s*:\s*"(-?\d+(?:\.\d+)?)"/)
      if (integrated) {
        resolve(Number(integrated[1]))
        return
      }
      const mean = log.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)
      resolve(mean ? Number(mean[1]) : null)
    })
  })
}

/** 把不同视频的平均响度拉近。返回相对用户音量的倍率，失败时是 1。 */
export async function measureLoudnessGain(url: string): Promise<number> {
  const href = validateAudioUrl(url)
  const cached = cache.get(href)
  if (cached) return cached
  const file = path.join(app.getPath('temp'), `bilimusic-loud-${createHash('sha1').update(href).digest('hex').slice(0, 16)}.bin`)
  try {
    await readSample(href, file)
    const loudness = await integratedLoudness(file)
    if (loudness == null || !Number.isFinite(loudness) || loudness < -50) return 1
    const shift = Math.max(-MAX_SHIFT_DB, Math.min(MAX_SHIFT_DB, TARGET_LUFS - loudness))
    const gain = 10 ** (shift / 20)
    cache.set(href, gain)
    if (cache.size > 200) cache.delete(cache.keys().next().value!)
    return gain
  } catch {
    return 1
  } finally {
    await fs.unlink(file).catch(() => {})
  }
}

export function registerLoudnessHandlers(): void {
  ipcMain.handle('audio:loudness', async (event, url: unknown) => {
    assertTrustedSender(event)
    if (typeof url !== 'string') return 1
    return measureLoudnessGain(url)
  })
}
