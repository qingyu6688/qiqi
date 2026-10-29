import { useEffect, useState } from 'react'
import type { AgentRound, TaskRecord } from '../types'

export default function AgentRoundProgress({ round, tasks, hasContent = false }: { round: AgentRound; tasks: TaskRecord[]; hasContent?: boolean }) {
  const [now, setNow] = useState(Date.now)
  const running = round.status === 'running'
  useEffect(() => {
    setNow(Date.now())
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, round.id, round.startedAt])

  const elapsed = Math.max(0, Math.floor(((running ? now : round.finishedAt ?? round.createdAt) - (round.startedAt ?? round.createdAt)) / 1000))
  const duration = elapsed < 60 ? `${elapsed}秒` : `${Math.floor(elapsed / 60)}分${String(elapsed % 60).padStart(2, '0')}秒`
  const completed = tasks.reduce((count, task) => count + task.outputImages.length, 0)
  const stopped = round.error === '已停止生成。'
  const canceled = tasks.filter((task) => task.status === 'error' && task.error === '已停止生成。').length
  const failed = tasks.filter((task) => task.status === 'error' && task.error !== '已停止生成。' && !task.falRecoverable && !task.customRecoverable).length
  const queued = tasks.filter((task) => task.status === 'running' && task.agentQueued).length
  const generating = tasks.filter((task) => task.status === 'running' && !task.agentQueued).length
  const settled = tasks.filter((task) => task.status === 'done' || (task.status === 'error' && !task.falRecoverable && !task.customRecoverable)).length
  const retry = round.requestState?.stage === 'retrying'
  const stage = !running
    ? stopped ? '已停止' : round.status === 'done' ? (failed ? '部分图片未完成' : '已完成') : completed ? '部分完成，回复已中断' : '生成失败'
    : round.requestState?.stage === 'queued' ? '等待生图名额'
    : retry ? `连接重试 ${round.requestState!.attempt - 1}/${round.requestState!.maxAttempts - 1}`
    : generating ? '正在生成图片'
    : queued ? '图片排队中'
    : tasks.length ? '正在整理回复'
    : round.requestState?.stage === 'connecting' ? '正在连接接口'
    : hasContent ? '正在生成回复' : '等待模型回复'

  return (
    <div className="mt-3 space-y-2 border-t border-black/[0.06] pt-3 text-xs text-gray-500 dark:border-white/[0.08] dark:text-gray-400" aria-label="回复进度">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1">
        <span className="inline-flex items-center gap-1.5" role="status">
          {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-700 dark:bg-amber-400" />}
          {stage}
        </span>
        <span className="tabular-nums">{running ? '已用时' : '总用时'} {duration}</span>
      </div>
      {tasks.length > 0 && <>
        <div className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
          <span>已完成 {completed}/{tasks.length} 张</span>
          {generating > 0 && <span>生成中 {generating} 张</span>}
          {queued > 0 && <span>排队 {queued} 张</span>}
          {failed > 0 && <span className="text-red-500 dark:text-red-400">失败 {failed} 张</span>}
          {canceled > 0 && <span>已停止 {canceled} 张</span>}
        </div>
        <progress aria-label="图片任务处理进度" max={tasks.length} value={settled} className={`block h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-black/[0.06] dark:[&::-webkit-progress-bar]:bg-white/10 ${failed ? '[&::-webkit-progress-value]:bg-red-400' : '[&::-webkit-progress-value]:bg-amber-700 dark:[&::-webkit-progress-value]:bg-amber-500'}`} />
      </>}
      {round.contextNotice && <p className="leading-relaxed">{round.contextNotice}</p>}
      {running && elapsed >= 90 && <p>接口处理较慢，请稍候；已完成的图片会保留。</p>}
    </div>
  )
}
