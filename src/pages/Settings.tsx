import { PROJECT_REPOSITORY, PROJECT_URL, RELEASES_URL } from '@/config/project'
import { openDownloadsFolder, getDownloadsFolderPath, friendlyDownloadError } from '@/services/downloadManager'
import { usePlayer } from '@/contexts/PlayerContext'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  FileDown,
  FileUp,
  Download,
  FolderOpen,
  Github,
  Info,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Music2,
  Palette,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  UserRound,
  Captions,
  Lock,
  LockOpen,
} from 'lucide-react'
import { ActionButton, MusicHero, MusicPageShell, MusicSection } from '@/components/AppleMusicPage'
import { useTheme } from '@/hooks/useTheme'
import { useAppSettings } from '@/hooks/useAppSettings'
import { useAuth } from '@/contexts/AuthContext'
import {
  loadDesktopLyricsSettings,
  saveDesktopLyricsSettings,
  type DesktopLyricsSettings,
} from '@/hooks/useDesktopLyrics'
import type { DesktopLyricsStyle } from '@/types/electron.d'
import { createPlaylistsExport, importPlaylistsFromText } from '@/utils/storage'
import type { AppSettings, SidebarState, ThemeMode } from '@/types'

export default function Settings() {
  const { mode, setMode } = useTheme()
  const { settings, setAppSettings } = useAppSettings()
  const { isLoggedIn, username, avatar, logout, setShowLogin } = useAuth()
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [playlistTransferMessage, setPlaylistTransferMessage] = useState('')
  const [appVersion, setAppVersion] = useState('1.0.0')
  const [updateStatus, setUpdateStatus] = useState('')
  const [updateAction, setUpdateAction] = useState<'restart' | 'reload' | null>(null)
  const [dl, setDl] = useState<DesktopLyricsSettings>(() => loadDesktopLyricsSettings())
  const [systemFonts, setSystemFonts] = useState<{ chinese: string[]; latin: string[] }>({ chinese: [], latin: [] })
  const [fontAdvanced, setFontAdvanced] = useState(false)

  useEffect(() => {
    window.electronAPI?.listSystemFonts?.().then(groups => {
      if (groups && Array.isArray(groups.chinese) && Array.isArray(groups.latin)) setSystemFonts(groups)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const sync = () => setDl(loadDesktopLyricsSettings())
    window.addEventListener('DESKTOP_LYRICS_CHANGED_EVENT', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('DESKTOP_LYRICS_CHANGED_EVENT', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const updateDl = (patch: { enabled?: boolean; locked?: boolean; style?: Partial<DesktopLyricsStyle> }) => {
    const current = loadDesktopLyricsSettings()
    const next: DesktopLyricsSettings = {
      ...current,
      ...patch,
      lockChosen: patch.locked !== undefined ? true : current.lockChosen,
      style: { ...current.style, ...(patch.style || {}) },
    }
    setDl(next)
    saveDesktopLyricsSettings(next)
  }

  useEffect(() => {
    window.electronAPI?.getAppVersion?.()?.then((v) => {
      if (v) setAppVersion(v)
    })
    return window.electronAPI?.onUpdaterEvent?.((event) => {
      switch (event.type) {
        case 'checking':
          setUpdateStatus('正在检查更新…'); setUpdateAction(null); break
        case 'unavailable':
          setUpdateStatus(event.message); setUpdateAction(null); break
        case 'up-to-date':
          setUpdateStatus(`已是最新版本（v${event.version}）`); setUpdateAction(null); break
        case 'available':
          setUpdateStatus(`发现新版本 v${event.version}，正在下载…`); setUpdateAction(null); break
        case 'progress':
          setUpdateStatus(`正在下载更新… ${event.percent}%`); break
        case 'downloaded':
          setUpdateStatus(`新版本 v${event.version} 已下载`); setUpdateAction('restart'); break
        case 'manual':
          setUpdateStatus('已打开下载页，请手动下载最新版本'); setUpdateAction(null); break
        case 'renderer-available':
          setUpdateStatus(`发现界面更新 v${event.version}，正在下载…`); setUpdateAction(null); break
        case 'renderer-progress':
          setUpdateStatus(`正在下载界面更新… ${event.percent}%`); break
        case 'renderer-ready-to-apply':
          setUpdateStatus(`界面更新 v${event.version} 已就绪`); setUpdateAction('reload'); break
        case 'error':
          setUpdateStatus(`检查更新失败：${event.message}`); setUpdateAction(null); break
      }
    })
  }, [])

  const checkUpdate = async () => {
    setUpdateStatus('正在检查更新…')
    setUpdateAction(null)
    try {
      if (!window.electronAPI?.checkForUpdate) throw new Error('请在桌面客户端中检查更新')
      await window.electronAPI.checkForUpdate()
    } catch (error) {
      setUpdateStatus(`检查更新失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const runUpdateAction = () => {
    if (updateAction === 'restart') window.electronAPI?.quitAndInstall?.()
    else if (updateAction === 'reload') window.electronAPI?.applyRendererUpdate?.()
  }

  const { showToast } = usePlayer()
  const [resolvedDownloadDir, setResolvedDownloadDir] = useState('')
  useEffect(() => { getDownloadsFolderPath().then(setResolvedDownloadDir).catch(() => setResolvedDownloadDir('请重新选择下载目录')) }, [settings.downloadDir])

  const changeDownloadDir = async () => {
    try {
      if (!window.electronAPI?.selectFolder) { showToast('请在桌面客户端中更改下载目录'); return }
      const selected = await window.electronAPI.selectFolder()
      if (selected) { setAppSettings({ downloadDir: selected }); showToast('下载目录已更新，旧音轨仍可在原目录播放') }
    } catch (error) { showToast(friendlyDownloadError(error)) }
  }

  const exportPlaylists = () => {
    const payload = createPlaylistsExport()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `bilimusic-playlists-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setPlaylistTransferMessage(`已导出 ${payload.playlists.length} 个歌单`)
  }

  const importPlaylists = async (file?: File) => {
    if (!file) return
    try {
      const result = importPlaylistsFromText(await file.text())
      setPlaylistTransferMessage(`已导入 ${result.imported} 个歌单${result.skipped ? `，跳过 ${result.skipped} 个无效项目` : ''}`)
    } catch (error) {
      setPlaylistTransferMessage(error instanceof Error ? error.message : '导入失败，请检查文件格式')
    } finally {
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="Preferences"
        title="设置"
        subtitle="整理外观、播放、下载和账号，让每一次打开都保持熟悉的节奏。"
        tone="red"
        action={(
          isLoggedIn ? (
            <ActionButton tone="subtle" onClick={logout}>
              <LogOut size={16} />
              退出登录
            </ActionButton>
          ) : (
            <ActionButton onClick={() => setShowLogin(true)}>
              <LogIn size={16} />
              扫码登录
            </ActionButton>
          )
        )}
      />

      <div className="settings-grid">
        <div className="settings-column">
          <SettingsGroup title="外观" icon={<Palette size={20} />}>
            <SettingsRow label="主题模式">
              <SegmentedControl
                options={[
                  { value: 'light' as ThemeMode, label: '浅色', icon: <Sun size={14} /> },
                  { value: 'dark' as ThemeMode, label: '深色', icon: <Moon size={14} /> },
                  { value: 'system' as ThemeMode, label: '系统', icon: <Monitor size={14} /> },
                ]}
                value={mode}
                onChange={setMode}
              />
            </SettingsRow>
            <SettingsRow label="侧边栏">
              <SegmentedControl
                options={[
                  { value: 'expanded' as SidebarState, label: '展开' },
                  { value: 'collapsed' as SidebarState, label: '折叠' },
                  { value: 'auto' as SidebarState, label: '自动' },
                ]}
                value={settings.sidebarState}
                onChange={(sidebarState) => setAppSettings({ sidebarState })}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title="播放" icon={<Music2 size={20} />}>
            <SettingsRow label="小窗画质" description="小窗默认 480p，比网页常见的高清更省流量。改完会马上重新加载当前画面">
              <StyledSelect
                value={settings.smallWindowQuality === '1080' ? '1080p' : settings.smallWindowQuality === '720' ? '720p' : '480p'}
                onChange={(label) => setAppSettings({
                  smallWindowQuality: label === '1080p' ? '1080' : label === '720p' ? '720' : '480',
                })}
                options={['480p', '720p', '1080p']}
              />
            </SettingsRow>
            <SettingsRow label="音质">
              <StyledSelect
                value={settings.playQuality}
                onChange={(playQuality) => setAppSettings({ playQuality: playQuality as AppSettings['playQuality'] })}
                options={['标准', '高品质', '无损']}
              />
            </SettingsRow>
            <SettingsRow label="打开软件就开始播放" description="上次那首歌和它所在的歌单都会留下来。打开后，一进软件就从上次的进度接着播；关掉则先停在那里，等你按播放">
              <ToggleSwitch checked={settings.resumeOnLaunch} onChange={() => setAppSettings({ resumeOnLaunch: !settings.resumeOnLaunch })} />
            </SettingsRow>
            <SettingsRow label="自动播放" description="播放结束时自动播放推荐">
              <ToggleSwitch checked={settings.autoPlay} onChange={() => setAppSettings({ autoPlay: !settings.autoPlay })} />
            </SettingsRow>
            <SettingsRow label="歌词显示" description="播放页自动显示歌词">
              <ToggleSwitch checked={settings.showLyrics} onChange={() => setAppSettings({ showLyrics: !settings.showLyrics })} />
            </SettingsRow>
            <SettingsRow label="失效曲目检查" description="打开软件时同一天最多查一次，或每七天查一次。查到稿件真的不在了会先列出歌名、UP 主、BV 号和原因，确认后才删除。网络失败的不删。歌单、最近播放和我喜欢里的手动按钮一直都在">
              <StyledSelect
                value={settings.unavailableCheck === 'launch' ? '打开软件时' : settings.unavailableCheck === 'weekly' ? '每七天' : '不检查'}
                onChange={(label) => setAppSettings({
                  unavailableCheck: label === '打开软件时' ? 'launch' : label === '每七天' ? 'weekly' : 'off',
                })}
                options={['不检查', '打开软件时', '每七天']}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title="下载" icon={<Download size={20} />}>
            <SettingsRow label="下载目录">
              <div className="settings-path">
                <span title={resolvedDownloadDir}>{resolvedDownloadDir || '默认下载目录'}</span>
                <button
                  type="button"
                  onClick={() => void openDownloadsFolder().catch(error => showToast(friendlyDownloadError(error)))}
                  title="在文件资源管理器中打开"
                >
                  <FolderOpen size={14} />
                  打开目录
                </button>
                <button type="button" onClick={changeDownloadDir} title="更改下载目录">
                  更改
                </button>
              </div>
            </SettingsRow>
            <SettingsRow label="下载格式">
              <StyledSelect
                value={settings.downloadFormat === 'm4a' ? 'M4A (原源格式)' : 'MP3 (推荐，兼容性强)'}
                onChange={(value) => setAppSettings({ downloadFormat: value.startsWith('M4A') ? 'm4a' : 'mp3' })}
                options={['MP3 (推荐，兼容性强)', 'M4A (原源格式)']}
              />
            </SettingsRow>
            <p className="settings-note">MP3 以 320kbps 导出并写入歌名、歌手、专辑及可用封面；有损转码不会提升原音质。M4A 保留原始音频流。</p>
          </SettingsGroup>
        </div>

        <div className="settings-column">
          <SettingsGroup title="桌面歌词" icon={<Captions size={20} />}>
            <SettingsRow label="启用桌面歌词" description="在桌面悬浮显示实时歌词（类似 QQ 音乐）">
              <ToggleSwitch checked={dl.enabled} onChange={() => updateDl({ enabled: !dl.enabled })} />
            </SettingsRow>
            {dl.enabled && (
              <>
                <SettingsRow
                  label={dl.locked ? '解锁以拖动' : '锁定位置'}
                  description={dl.locked ? '当前鼠标穿透。把鼠标移到歌词上，点出现的「解锁」；这里也可以解锁' : '悬停歌词可拖动、拉左右两边改宽度，A− A+ 改字号。锁定后鼠标穿透，移上去可以解锁'}
                >
                  <button type="button" className="am-action am-action--subtle" onClick={() => updateDl({ locked: !dl.locked })}>
                    {dl.locked ? <LockOpen size={15} /> : <Lock size={15} />}
                    {dl.locked ? '解锁拖动' : '锁定'}
                  </button>
                </SettingsRow>
                <SettingsRow label="字体" description="默认用中文字体显示汉字，英文用 Times New Roman">
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                    <select
                      className="settings-select"
                      value={dl.style.fontFamily || 'Microsoft YaHei'}
                      onChange={(event) => updateDl({ style: { fontFamily: event.target.value } })}
                    >
                      {!(systemFonts.chinese.includes(dl.style.fontFamily || 'Microsoft YaHei')) && (
                        <option value={dl.style.fontFamily || 'Microsoft YaHei'}>{dl.style.fontFamily || 'Microsoft YaHei'}</option>
                      )}
                      {(systemFonts.chinese.length ? systemFonts.chinese : ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi']).map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                    <button type="button" className="am-action am-action--subtle" onClick={() => setFontAdvanced(open => !open)}>
                      高级设置
                    </button>
                    {fontAdvanced && (
                      <select
                        className="settings-select"
                        aria-label="英文字体"
                        value={dl.style.latinFontFamily || 'Times New Roman'}
                        onChange={(event) => updateDl({ style: { latinFontFamily: event.target.value } })}
                      >
                        {(systemFonts.latin.length ? systemFonts.latin : ['Times New Roman', 'Segoe UI', 'Arial']).map(name => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </SettingsRow>
                <SettingsRow label="回到默认位置" description="歌词被拖到角落里找不到时，放回屏幕下方中间">
                  <button type="button" className="am-action am-action--subtle" onClick={() => window.electronAPI?.desktopLyrics?.resetPosition?.()}>
                    复位
                  </button>
                </SettingsRow>
                <SettingsRow label="字号">
                  <input
                    type="range"
                    min={18}
                    max={64}
                    value={dl.style.fontSize}
                    onChange={(e) => updateDl({ style: { fontSize: Number(e.target.value) } })}
                    style={{ width: 140 }}
                  />
                  <span style={{ marginLeft: 8, minWidth: 36, textAlign: 'right' }}>{dl.style.fontSize}px</span>
                </SettingsRow>
                <SettingsRow label="颜色">
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {['#ff375f', '#ffffff', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2'].map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => updateDl({ style: { color: c } })}
                        aria-label={c}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          background: c,
                          border: dl.style.color === c ? '2px solid var(--color-foreground)' : '1px solid rgba(128,128,128,.4)',
                          cursor: 'pointer',
                        }}
                      />
                    ))}
                    <input
                      type="color"
                      value={dl.style.color.startsWith('#') ? dl.style.color : '#ff375f'}
                      onChange={(e) => updateDl({ style: { color: e.target.value } })}
                      style={{ width: 28, height: 24, border: 'none', background: 'none', cursor: 'pointer' }}
                    />
                  </div>
                </SettingsRow>
                <SettingsRow label="描边" description="深色描边提升浅色背景下的可读性">
                  <ToggleSwitch checked={dl.style.outline} onChange={() => updateDl({ style: { outline: !dl.style.outline } })} />
                </SettingsRow>
                <SettingsRow label="背景条" description="歌词后面加半透明底条">
                  <ToggleSwitch checked={dl.style.showBg} onChange={() => updateDl({ style: { showBg: !dl.style.showBg } })} />
                </SettingsRow>
                <SettingsRow label="加粗">
                  <ToggleSwitch checked={dl.style.bold} onChange={() => updateDl({ style: { bold: !dl.style.bold } })} />
                </SettingsRow>
                <SettingsRow label="预览">
                  <span
                    style={{
                      fontSize: Math.min(dl.style.fontSize, 22),
                      fontWeight: dl.style.bold ? 800 : 400,
                      color: dl.style.color,
                      WebkitTextStroke: dl.style.outline ? `${dl.style.outlineWidth || 2}px ${dl.style.outlineColor}` : '0px transparent',
                      paintOrder: 'stroke fill',
                      background: dl.style.showBg ? dl.style.bgColor : 'linear-gradient(90deg, #f4f4f5 0 50%, transparent 50% 100%)',
                      padding: '4px 12px',
                      borderRadius: dl.style.showBg ? dl.style.bgRadius : 8,
                    }}
                  >
                    歌词预览 Sample
                  </span>
                </SettingsRow>
              </>
            )}
          </SettingsGroup>

          <SettingsGroup title="歌单迁移" icon={<FileDown size={20} />}>
            <div className="settings-actions settings-actions--stacked">
              <button type="button" onClick={exportPlaylists}>
                <FileDown size={14} />
                导出歌单
              </button>
              <button type="button" onClick={() => importInputRef.current?.click()}>
                <FileUp size={14} />
                导入歌单
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => importPlaylists(e.target.files?.[0])}
              />
              {playlistTransferMessage && <span>{playlistTransferMessage}</span>}
            </div>
          </SettingsGroup>

          <SettingsGroup title="账号" icon={<UserRound size={20} />}>
            <div className="settings-account">
              <div className="settings-account__avatar">
                {isLoggedIn && avatar ? <img src={avatar} alt="" /> : <UserRound size={22} />}
              </div>
              <div className="settings-account__body">
                <span className={isLoggedIn ? 'is-online' : ''}>{isLoggedIn ? '已登录' : '未登录'}</span>
                <strong>{isLoggedIn ? username : 'BiliBili 账号'}</strong>
              </div>
              <button type="button" onClick={isLoggedIn ? logout : () => setShowLogin(true)}>
                {isLoggedIn ? <LogOut size={14} /> : <LogIn size={14} />}
                {isLoggedIn ? '退出' : '登录'}
              </button>
            </div>
          </SettingsGroup>

          <SettingsGroup title="关于" icon={<Info size={20} />}>
            <SettingsRow label="更新来源" description="仅检查此 fork 的正式 Releases；未发布版本时会明确提示，不会从原仓库下载更新。">
              <span>{PROJECT_REPOSITORY}</span>
            </SettingsRow>
            <SettingsRow label="版本">
              <span className="settings-version">BiliMusic v{appVersion}</span>
            </SettingsRow>
            <div className="settings-actions">
              <button type="button" onClick={checkUpdate}>
                <SettingsIcon size={14} />
                检查更新
              </button>
              {updateAction && (
                <button type="button" onClick={runUpdateAction}>
                  <RefreshCw size={14} />
                  {updateAction === 'restart' ? '重启并安装' : '立即重载'}
                </button>
              )}
              <button type="button" onClick={() => window.electronAPI?.openExternal?.(PROJECT_URL)}>
                <Github size={14} />
                关于项目
              </button>
              <button type="button" onClick={() => window.electronAPI?.openExternal?.(RELEASES_URL)}>
                <Download size={14} />
                版本发布页
              </button>
              {updateStatus && <span role="status">{updateStatus}</span>}
            </div>
          </SettingsGroup>
        </div>
      </div>
    </MusicPageShell>
  )
}

function SettingsGroup({
  title,
  icon,
  children,
}: {
  title: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <MusicSection title={title} icon={icon}>
      <div className="settings-panel">{children}</div>
    </MusicSection>
  )
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  )
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: ReactNode }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="settings-segment">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? 'is-active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function StyledSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: string[]
}) {
  return (
    <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(option => <option key={option}>{option}</option>)}
    </select>
  )
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      className={`settings-toggle ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={onChange}
    >
      <span />
    </button>
  )
}
