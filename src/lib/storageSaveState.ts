export type StorageSaveSource = 'settings' | 'tasks' | 'conversations'

interface StorageSaveIssue {
  source: StorageSaveSource
  message: string
}

interface StorageSaveState {
  issues: StorageSaveIssue[]
  pending: boolean
  exitBlocked: string | null
}

const messages: Record<StorageSaveSource, string> = {
  settings: '设置尚未保存，API 配置等最新改动暂时只保留在内存中。',
  tasks: '部分任务记录尚未保存，请保持客户端打开，避免丢失最新图片记录。',
  conversations: '对话尚未保存，最新消息暂时只保留在内存中。',
}
const failures = new Map<StorageSaveSource, StorageSaveIssue>()
const pendingSources = new Set<StorageSaveSource>()
const handlers = new Map<StorageSaveSource, () => Promise<void>>()
const listeners = new Set<() => void>()
let snapshot: StorageSaveState = { issues: [], pending: false, exitBlocked: null }

function publish(exitBlocked = snapshot.exitBlocked): void {
  snapshot = {
    issues: [...failures.values()],
    pending: pendingSources.size > 0,
    exitBlocked: failures.size || pendingSources.size ? exitBlocked : null,
  }
  for (const listener of listeners) listener()
}

export function getStorageSaveState(): StorageSaveState {
  return snapshot
}

export function subscribeStorageSaveState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 每种数据由原持久化模块负责串行写入，这里只协调退出与失败后的手动重试。 */
export function registerStorageSaveHandler(source: StorageSaveSource, handler: () => Promise<void>): () => void {
  handlers.set(source, handler)
  return () => {
    if (handlers.get(source) === handler) handlers.delete(source)
  }
}

export function setStorageSavePending(source: StorageSaveSource, pending: boolean): void {
  if (pendingSources.has(source) === pending) return
  if (pending) pendingSources.add(source)
  else pendingSources.delete(source)
  publish()
}

export function reportStorageSaveFailure(source: StorageSaveSource): void {
  if (failures.has(source)) return
  failures.set(source, { source, message: messages[source] })
  publish()
}

export function clearStorageSaveFailure(source: StorageSaveSource): void {
  if (!failures.delete(source)) return
  publish()
}

export function setStorageExitBlocked(message: string | null): void {
  publish(message)
}

export async function flushRegisteredStorageSaves(): Promise<void> {
  const results = await Promise.allSettled([...handlers].map(async ([source, handler]) => {
    try {
      await handler()
    } catch (err) {
      reportStorageSaveFailure(source)
      throw err
    }
  }))
  if (results.some((result) => result.status === 'rejected') || failures.size || pendingSources.size) {
    throw new Error('本地数据尚未全部保存，请重试保存后再关闭或安装更新。')
  }
}
