import { execFile } from 'node:child_process'
import { ipcMain } from 'electron'
import { assertTrustedSender } from './security'

export interface SystemFontGroups {
  chinese: string[]
  latin: string[]
}

let cached: SystemFontGroups | null = null

function isChineseFont(name: string): boolean {
  if (/[\u3400-\u9fff]/.test(name)) return true
  return /yahei|simsun|simhei|kaiti|fangsong|dengxian|source han|noto (sans|serif) cjk|noto sans sc|noto serif sc|pingfang|jhenghei|mingliu|stkaiti|stsong|stheiti|stfangsong|lisu|youyuan|microsoft yahei|方正|思源|文泉驿|冬青/i.test(name)
}

function listNames(): Promise<string[]> {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '[System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }',
  ].join('; ')
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error || !stdout) {
        resolve([])
        return
      }
      resolve(stdout.split(/\r?\n/).map(line => line.trim()).filter(name => name.length >= 2 && name.length <= 80 && !name.includes('\uFFFD')))
    })
  })
}

export async function listSystemFonts(): Promise<SystemFontGroups> {
  if (cached) return cached
  const names = process.platform === 'win32' ? await listNames() : ['Microsoft YaHei', 'SimSun', 'Times New Roman', 'Segoe UI']
  const unique = [...new Set(names)]
  const chinese = unique.filter(isChineseFont).sort((a, b) => a.localeCompare(b, 'zh'))
  const latin = unique.filter(name => !isChineseFont(name)).sort((a, b) => a.localeCompare(b, 'en'))
  if (!latin.some(name => name.toLowerCase() === 'times new roman')) latin.unshift('Times New Roman')
  cached = {
    chinese: chinese.length ? chinese : ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi'],
    latin,
  }
  return cached
}

export function registerSystemFontHandlers(): void {
  ipcMain.handle('system:fonts', async (event) => {
    assertTrustedSender(event)
    return listSystemFonts()
  })
}
