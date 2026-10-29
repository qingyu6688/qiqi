import { clearStorageSaveFailure, registerStorageSaveHandler, reportStorageSaveFailure, setStorageSavePending, type StorageSaveSource } from './storageSaveState'

interface WriteWaiter {
  resolve: () => void
  reject: (error: unknown) => void
}

interface PendingWrite<T> {
  value: T
  waiters: WriteWaiter[]
}

/** 同一记录只写最新快照；失败的快照留在内存，供显式重试和退出前补写。 */
export function createStorageWriteQueue<T>(source: StorageSaveSource, save: (value: T) => Promise<unknown>) {
  const pending = new Map<string, PendingWrite<T>>()
  let running: Promise<void> | null = null

  function flush(): Promise<void> {
    if (running) return running
    if (!pending.size) return Promise.resolve()
    running = Promise.resolve().then(async () => {
      let activeWaiters: WriteWaiter[] = []
      try {
        while (pending.size) {
          const [key, entry] = pending.entries().next().value!
          const value = entry.value
          activeWaiters = entry.waiters
          entry.waiters = []
          await save(value)
          for (const waiter of activeWaiters) waiter.resolve()
          activeWaiters = []
          pending.delete(key)
          if (entry.value === value) {
            for (const waiter of entry.waiters) waiter.resolve()
          } else {
            // 流式任务可能持续更新，将它的新快照排到末尾，让其他记录也能及时保存。
            pending.set(key, entry)
          }
        }
        clearStorageSaveFailure(source)
      } catch (err) {
        for (const waiter of activeWaiters) waiter.reject(err)
        for (const entry of pending.values()) {
          for (const waiter of entry.waiters) waiter.reject(err)
          entry.waiters = []
        }
        reportStorageSaveFailure(source)
        throw err
      } finally {
        running = null
        setStorageSavePending(source, pending.size > 0)
      }
    })
    return running
  }

  registerStorageSaveHandler(source, flush)
  return {
    flush,
    enqueue(key: string, value: T): Promise<void> {
      const entry = pending.get(key) ?? { value, waiters: [] }
      entry.value = value
      const saved = new Promise<void>((resolve, reject) => entry.waiters.push({ resolve, reject }))
      pending.set(key, entry)
      setStorageSavePending(source, true)
      void flush().catch(() => {
        if (pending.size) reportStorageSaveFailure(source)
      })
      return saved
    },
  }
}
