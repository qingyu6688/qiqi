// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AgentRound, type TaskRecord } from '../types'
import AgentRoundProgress from './AgentRoundProgress'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const round: AgentRound = { id: 'round', index: 1, userMessageId: 'user', prompt: '生成五张图', inputImageIds: [], outputTaskIds: [], status: 'running', error: null, createdAt: 0, startedAt: 0, finishedAt: null }
const task = (id: string, status: TaskRecord['status'], agentQueued = false): TaskRecord => ({ id, status, agentQueued, params: DEFAULT_PARAMS, prompt: '', inputImageIds: [], outputImages: status === 'done' ? [id] : [], error: null, createdAt: 0, finishedAt: null, elapsed: null })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(5000)
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

it('等待回复时显示真实已用时，未出图时不显示虚构百分比', async () => {
  await act(async () => root.render(<AgentRoundProgress round={round} tasks={[]} />))
  expect(container.textContent).toContain('等待模型回复')
  expect(container.textContent).toContain('已用时 5秒')
  expect(container.querySelector('progress')).toBeNull()
  act(() => vi.advanceTimersByTime(2000))
  expect(container.textContent).toContain('已用时 7秒')
})

it('显示五张图片的完成、生成、排队和失败数量', async () => {
  const tasks = [task('1', 'done'), task('2', 'running'), task('3', 'running'), task('4', 'running', true), task('5', 'error')]
  await act(async () => root.render(<AgentRoundProgress round={round} tasks={tasks} />))
  expect(container.textContent).toContain('已完成 1/5 张')
  expect(container.textContent).toContain('生成中 2 张')
  expect(container.textContent).toContain('排队 1 张')
  expect(container.textContent).toContain('失败 1 张')
  expect(container.querySelector('progress')?.value).toBe(2)
})

it('连接重试可见，结束后停止计时并保留成功张数', async () => {
  await act(async () => root.render(<AgentRoundProgress round={{ ...round, requestState: { stage: 'retrying', attempt: 2, maxAttempts: 3 } }} tasks={[]} />))
  expect(container.textContent).toContain('连接重试 1/2')
  await act(async () => root.render(<AgentRoundProgress round={{ ...round, status: 'error', finishedAt: 61000 }} tasks={[task('1', 'done'), task('2', 'error')]} />))
  expect(container.textContent).toContain('部分完成，回复已中断')
  expect(container.textContent).toContain('总用时 1分01秒')
  act(() => vi.advanceTimersByTime(10000))
  expect(container.textContent).toContain('总用时 1分01秒')
})

it('主动停止不计为接口失败', async () => {
  await act(async () => root.render(<AgentRoundProgress round={{ ...round, status: 'error', error: '已停止生成。', finishedAt: 5000 }} tasks={[{ ...task('1', 'error'), error: '已停止生成。' }]} />))
  expect(container.textContent).toContain('已停止 1 张')
  expect(container.textContent).not.toContain('失败')
})
