import { useState, useSyncExternalStore } from 'react'
import { getStorageSaveState, subscribeStorageSaveState } from '../lib/storageSaveState'
import { flushTauriStorageBeforeExit } from '../lib/tauriStorage'

/** 保存失败持续显示，只有对应数据真正落盘后才自动收起。 */
export default function StorageSaveNotice() {
  const state = useSyncExternalStore(subscribeStorageSaveState, getStorageSaveState)
  const [retrying, setRetrying] = useState(false)
  if (!state.issues.length && !state.exitBlocked) return null

  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await flushTauriStorageBeforeExit()
    } catch (err) {
      console.warn('重试保存本地数据未完成：', err)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[130] w-[min(32rem,calc(100vw-32px))]" role="alert">
      <div className="rounded-2xl border border-amber-200 bg-amber-50/95 px-4 py-3 text-sm text-amber-900 shadow-lg backdrop-blur-xl dark:border-amber-500/30 dark:bg-amber-950/95 dark:text-amber-100">
        <p className="font-semibold">本地数据尚未保存</p>
        {state.issues.map((issue) => <p className="mt-1 leading-5" key={issue.source}>{issue.message}</p>)}
        {state.exitBlocked && <p className="mt-1 leading-5">{state.exitBlocked}</p>}
        <p className="mt-1 text-xs leading-5">请检查磁盘剩余空间和数据目录权限，保存成功前保持客户端打开。</p>
        <button
          type="button"
          disabled={retrying}
          onClick={() => void retry()}
          className="mt-2 rounded-lg border border-amber-300 px-3 py-1.5 font-medium hover:bg-amber-100 disabled:opacity-60 dark:border-amber-500/40 dark:hover:bg-amber-900"
        >
          {retrying ? '正在等待保存…' : '重试保存'}
        </button>
      </div>
    </div>
  )
}
