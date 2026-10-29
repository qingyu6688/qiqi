import { useState, type ReactNode } from 'react'
import { checkForUpdates, setUpdateModalOpen, useReleaseUpdates } from '../../hooks/useReleaseUpdates'
import { compareVersions, LICENSE_URL, MANUAL_CHECK_MIN_INTERVAL_MS, RELEASE_REPO } from '../../lib/releaseUpdates'
import { useStore } from '../../store'
import { APP_DESCRIPTION, APP_ICON, APP_NAME, UPSTREAM_URL } from '../../lib/brand'
import { PawTrail } from '../CatDecorations'
import { ChevronRightIcon, ExternalLinkIcon, GithubIcon, HistoryIcon, RefreshIcon } from '../icons'

interface AboutRowProps {
  icon: ReactNode
  title: string
  subtitle?: string
  right?: ReactNode
  href?: string
  onClick?: () => void
  disabled?: boolean
  highlight?: boolean
}

/** 列表中的一行：有 href 时为外链，否则为按钮 */
function AboutRow({ icon, title, subtitle, right, href, onClick, disabled, highlight }: AboutRowProps) {
  const className = `flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors disabled:cursor-default ${highlight ? 'bg-blue-500/[0.08] hover:bg-blue-500/[0.12] focus-visible:bg-blue-500/[0.12] dark:bg-blue-500/[0.12] dark:hover:bg-blue-500/[0.16] dark:focus-visible:bg-blue-500/[0.16]' : 'hover:bg-black/[0.03] focus-visible:bg-black/[0.03] dark:hover:bg-white/[0.04] dark:focus-visible:bg-white/[0.04]'}`
  const content = (
    <>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${highlight ? 'bg-blue-500 text-white' : 'bg-white text-gray-600 shadow-sm dark:bg-white/[0.08] dark:text-gray-300 dark:shadow-none'}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${highlight ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-gray-800 dark:text-gray-100'}`}>{title}</span>
        {subtitle && <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{subtitle}</span>}
      </span>
      {right}
    </>
  )
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {content}
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      {content}
    </button>
  )
}

/** 设置页样式的卡片：标题行下是以细线分隔的若干行 */
function AboutCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06]">
      <div className="flex items-center gap-2 px-4 pb-1 pt-4 text-gray-700 dark:text-gray-300">
        {icon}
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">{title}</h4>
      </div>
      <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">{children}</div>
    </div>
  )
}

const CHEVRON = <ChevronRightIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
const EXTERNAL = <ExternalLinkIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />

export default function AboutSettingsTab({ onOpenFontLicenses }: { onOpenFontLicenses: () => void }) {
  const showToast = useStore((s) => s.showToast)
  const latest = useReleaseUpdates((s) => s.releases[0])
  const checkError = useReleaseUpdates((s) => s.checkError)
  const [checking, setChecking] = useState(false)
  const hasUpdate = Boolean(latest && compareVersions(latest.version, __APP_VERSION__) > 0)

  const handleCheck = async () => {
    setChecking(true)
    try {
      const next = await checkForUpdates(MANUAL_CHECK_MIN_INTERVAL_MS)
      if (next && compareVersions(next.version, __APP_VERSION__) > 0) setUpdateModalOpen(true)
      else showToast('已是最新版本', 'success')
    } catch (err) {
      showToast(`检查更新失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="relative flex items-center gap-4 overflow-hidden rounded-2xl bg-black/[0.04] p-4 dark:bg-white/[0.06]">
        <img src={APP_ICON} alt="" className="h-14 w-14 shrink-0" />
        <div>
          <h4 className="text-base font-bold text-gray-800 dark:text-gray-100">{APP_NAME}</h4>
          <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">{APP_DESCRIPTION}</p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">v{__APP_VERSION__} · 本机记忆版</p>
        </div>
        <PawTrail className="absolute bottom-2 right-3 hidden sm:inline-flex" />
      </div>

      <AboutCard icon={<HistoryIcon className="h-4 w-4" />} title="对话与数据">
        <div className="px-4 py-3 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          对话、图片和设置保存在当前设备。继续同一对话会带入历史文字与图片；新建对话使用独立上下文。网页端与桌面端各自保存，可通过导入导出备份迁移。
        </div>
      </AboutCard>

      <AboutCard icon={<RefreshIcon className="h-4 w-4" />} title="版本与更新">
        <AboutRow
          icon={<RefreshIcon className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />}
          title={hasUpdate ? '发现新版本' : '检查更新'}
          subtitle={!RELEASE_REPO ? '尚未配置柒柒的发布仓库，当前使用本地版本。' : checkError || `当前版本 v${__APP_VERSION__}`}
          onClick={() => hasUpdate ? setUpdateModalOpen(true) : void handleCheck()}
          disabled={checking || !RELEASE_REPO}
          highlight={hasUpdate}
          right={checking ? <span className="text-xs text-gray-500">正在检查…</span> : hasUpdate ? CHEVRON : undefined}
        />
        {RELEASE_REPO && <AboutRow icon={<HistoryIcon className="h-4 w-4" />} title="更新日志" onClick={() => setUpdateModalOpen(true)} right={CHEVRON} />}
      </AboutCard>

      <AboutCard icon={<GithubIcon className="h-4 w-4" />} title="开源与许可">
        <AboutRow
          icon={<GithubIcon className="h-4 w-4" />}
          title="基于 GPT Image Playground"
          subtitle="原项目作者 CookSleep；柒柒在此基础上继续开发。"
          href={UPSTREAM_URL}
          right={EXTERNAL}
        />
        <AboutRow icon={<ExternalLinkIcon className="h-4 w-4" />} title="原项目 MIT 许可证" href={LICENSE_URL} right={EXTERNAL} />
        <AboutRow
          icon={<HistoryIcon className="h-4 w-4" />}
          title="第三方许可"
          subtitle="字体和依赖库的完整许可声明"
          onClick={onOpenFontLicenses}
          right={CHEVRON}
        />
      </AboutCard>
    </div>
  )
}
