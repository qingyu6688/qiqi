import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

export default function SupportPromptModal() {
  const supportPromptOpen = useStore((s) => s.supportPromptOpen)
  const dismissSupportPrompt = useStore((s) => s.dismissSupportPrompt)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const confirmDialog = useStore((s) => s.confirmDialog)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const showSettings = useStore((s) => s.showSettings)
  const maskEditorImageId = useStore((s) => s.maskEditorImageId)
  const sketchBoard = useStore((s) => s.sketchBoard)
  // 隐私模式中暂不显示，退出后再出现
  const privacyMode = useStore((s) => Boolean(s.privacyMode))

  const blockedByHigherPriorityModal = Boolean(
    privacyMode || confirmDialog || detailTaskId || lightboxImageId || showSettings || maskEditorImageId || sketchBoard,
  )
  const visible = supportPromptOpen && !blockedByHigherPriorityModal

  useCloseOnEscape(visible, dismissSupportPrompt)
  usePreventBackgroundScroll(visible)

  if (!visible) return null

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      onClick={dismissSupportPrompt}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" />
      <div
        className="relative z-10 w-full max-w-sm rounded-[2rem] border border-white/50 bg-white/95 p-6 pb-7 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute right-4 top-4">
          <button
            type="button"
            onClick={dismissSupportPrompt}
            className="rounded-full p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-5 mt-4 flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-[1.5rem] bg-[#f4f0ff] text-[#946ce6] dark:bg-[#946ce6]/10 dark:text-[#bba3f2]">
            <svg className="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </div>
        </div>

        <h3 className="mb-3 text-center text-xl font-bold text-gray-800 dark:text-gray-100">
          为创作留一份备份
        </h3>

        <p className="mb-8 px-2 text-center text-[15px] leading-relaxed text-gray-500 dark:text-gray-400">
          图片和对话都保存在当前设备。<br />
          定期导出备份，换浏览器或迁移设备时，<br />
          还能继续之前的创作。
        </p>

        <div className="flex justify-center gap-3">
          <button type="button" onClick={dismissSupportPrompt} className="rounded-xl bg-gray-100 px-5 py-3 text-sm text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">稍后再说</button>
          <button
            type="button"
            onClick={() => {
              dismissSupportPrompt()
              setShowSettings(true, 'data')
            }}
            className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white hover:bg-blue-700"
          >
            打开数据管理
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
