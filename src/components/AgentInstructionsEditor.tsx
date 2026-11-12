import { useEffect, useId, useState } from 'react'
import { MAX_AGENT_INSTRUCTION_LENGTH } from '../lib/agentGuidance'

export default function AgentInstructionsEditor({ title, description, value, onSave }: {
  title: string
  description: string
  value: string
  onSave: (value: string) => void | Promise<void>
}) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => { setDraft(value) }, [value])

  const save = async () => {
    setSaving(true)
    setStatus('')
    try {
      await onSave(draft.trim())
      setFailed(false)
      setStatus('已保存，下轮生效')
    } catch (err) {
      setFailed(true)
      setStatus(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="rounded-xl border border-black/10 bg-white/60 px-4 py-3 text-sm dark:border-white/10 dark:bg-white/[0.02]">
      <summary className="cursor-pointer font-medium text-gray-700 dark:text-gray-200">{title}{value ? ' · 已启用' : ''}</summary>
      <div className="mt-3 space-y-3">
        <p id={`${id}-help`} className="text-xs leading-5 text-gray-500 dark:text-gray-400">{description}设定保存在本机，每轮都会带上；当前消息可覆盖其中的要求。留空并保存可清除。</p>
        <textarea id={id} aria-label={title} aria-describedby={`${id}-help`} value={draft} disabled={saving} maxLength={MAX_AGENT_INSTRUCTION_LENGTH}
          onChange={(event) => { setDraft(event.target.value); setStatus('') }} rows={5}
          placeholder="例如：主角是一只戴蓝色围巾的白猫，水彩画风，画面中不出现其他文字。"
          className="w-full resize-y rounded-xl border border-black/10 bg-white px-3 py-2 text-sm leading-6 text-gray-800 outline-none focus:border-blue-400 dark:border-white/10 dark:bg-gray-900 dark:text-gray-200" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-gray-400">{draft.length}/{MAX_AGENT_INSTRUCTION_LENGTH}</span>
          <div className="flex items-center gap-3">
            {status && <span role={failed ? 'alert' : 'status'} className={`text-xs ${failed ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}>{status}</span>}
            <button type="button" disabled={saving} onClick={() => { void save() }} className="rounded-lg bg-blue-500 px-4 py-2 text-xs text-white transition-colors hover:bg-blue-600 disabled:opacity-50">{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
      </div>
    </details>
  )
}
