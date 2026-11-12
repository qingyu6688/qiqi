import { describe, expect, it } from 'vitest'
import type { AgentRound, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { getSelectedImageMentionLabel, getSelectedTextMentionLabel } from './promptImageMentions'
import { AGENT_IMAGE_PROMPT_EXCERPT_MARKER, createAgentReferenceBatch, extractAgentReferenceIds, getAgentImageReferenceIds, MAX_AGENT_IMAGE_PROMPT_LENGTH, preserveAgentImageRequirements, replaceAgentPromptImageReferencesForApi, resolveAgentPromptImageReferences } from './agentImageReferences'

const round = (patch: Partial<AgentRound>): AgentRound => ({
  id: patch.id ?? `round-${patch.index ?? 1}`,
  index: patch.index ?? 1,
  parentRoundId: patch.parentRoundId ?? null,
  userMessageId: patch.userMessageId ?? `user-${patch.index ?? 1}`,
  prompt: patch.prompt ?? '',
  inputImageIds: patch.inputImageIds ?? [],
  outputTaskIds: patch.outputTaskIds ?? [],
  status: patch.status ?? 'done',
  error: patch.error ?? null,
  createdAt: patch.createdAt ?? 1,
  finishedAt: patch.finishedAt ?? 2,
  ...(patch.assistantMessageId ? { assistantMessageId: patch.assistantMessageId } : {}),
})

const task = (id: string, outputImages: string[]): TaskRecord => ({
  id,
  prompt: 'prompt',
  params: { ...DEFAULT_PARAMS },
  inputImageIds: [],
  maskTargetImageId: null,
  maskImageId: null,
  outputImages,
  status: 'done',
  error: null,
  createdAt: 1,
  finishedAt: 2,
  elapsed: 1,
})

describe('agent image references', () => {
  it('两万字资料和两份八千字设定不会超长，保留规划、原话首尾及摘录标记', () => {
    const planned = '白猫海报，指定文字“柒柒”，蓝底，不要边框'
    const original = `开头要求：两只白猫${'参考资料'.repeat(5000)}结尾要求：不要红色`
    const prompt = preserveAgentImageRequirements(planned, original, 0, { conversationInstructions: '对话设定'.repeat(2000), globalInstructions: '全局偏好'.repeat(2000) })
    expect(prompt.length).toBeLessThanOrEqual(MAX_AGENT_IMAGE_PROMPT_LENGTH)
    expect(prompt.startsWith(planned)).toBe(true)
    expect(prompt).toContain('开头要求：两只白猫')
    expect(prompt).toContain('结尾要求：不要红色')
    expect(prompt).toContain(AGENT_IMAGE_PROMPT_EXCERPT_MARKER)
  })

  it('规划本身很长时依次压缩附加内容，规划完整保留且原话首尾仍在', () => {
    const planned = `完整规划起点${'画面细节'.repeat(5000)}完整规划终点`
    const prompt = preserveAgentImageRequirements(planned, `原话首段${'资料'.repeat(10_000)}原话末段`, 0, {
      conversationInstructions: `角色首段${'设定'.repeat(3990)}角色末段`,
      globalInstructions: '个人偏好'.repeat(2000),
    })
    expect(prompt.length).toBeLessThanOrEqual(MAX_AGENT_IMAGE_PROMPT_LENGTH)
    expect(prompt.startsWith(planned)).toBe(true)
    expect(prompt).toContain('原话首段')
    expect(prompt).toContain('原话末段')
    expect(prompt).toContain('角色首段')
    expect(prompt).toContain('角色末段')
  })

  it('完整规划超过可提交长度时明确拒绝，不截断规划', () => {
    expect(() => preserveAgentImageRequirements('画'.repeat(MAX_AGENT_IMAGE_PROMPT_LENGTH + 1), '白猫', 0)).toThrow('未提交生图请求')
  })

  it('逐张参考图路径只拼接一次标准化原话，长原话同样受预算约束', () => {
    const original = `依次根据每张图生成白猫海报，开头要求蓝色${'参考资料'.repeat(5000)}结尾不要边框`
    const plans = createAgentReferenceBatch(original, 5, 5, false)!
    expect(plans).toHaveLength(5)
    for (const item of plans) {
      const prompt = preserveAgentImageRequirements(item.prompt, original, 5)
      expect(prompt.split('开头要求蓝色')).toHaveLength(2)
      expect(prompt.split('结尾不要边框')).toHaveLength(2)
      expect(prompt).not.toContain('用户要求：')
      expect(prompt).toContain('用户原始要求：')
      expect(prompt.length).toBeLessThanOrEqual(MAX_AGENT_IMAGE_PROMPT_LENGTH)
    }
  })
  it('每张保留原话中的文字、颜色、数量和禁止项，原话已经存在时不重复添加', () => {
    const original = '生成三张海报，文字必须是“柒柒”，天蓝色底，右下角两只猫，不要边框'
    for (let i = 1; i <= 3; i++) {
      const result = preserveAgentImageRequirements(`第 ${i} 张海报`, original, 0, { conversationInstructions: '主角为戴蓝围巾的白猫' })
      expect(result.startsWith(`第 ${i} 张海报`)).toBe(true)
      expect(result).toContain(original)
      expect(result).toContain('其他图片的主题不画进本张')
      expect(result).toContain('主角为戴蓝围巾的白猫')
    }
    expect(preserveAgentImageRequirements(`用户要求：${original}`, original, 0)).toBe(`用户要求：${original}`)
  })

  it('漏写引用标签时带上本轮所有参考图，显式引用不额外加入其他参考图', () => {
    const current = round({ index: 3, inputImageIds: ['cat', 'style'] })
    expect(getAgentImageReferenceIds('白猫在海边', current)).toEqual(['round-3-reference-1', 'round-3-reference-2'])
    expect(getAgentImageReferenceIds('参考 <ref id="round-1-image-2" />', current)).toEqual(['round-1-image-2'])
    expect(getAgentImageReferenceIds('纯文字生图', round({ index: 2 }))).toEqual([])
  })
  it('只把明确的一图对应一张成图请求拆进本地队列', () => {
    const text = '依次根据每张图里面的毛毯图案生成相似风格不同款式'
    expect(createAgentReferenceBatch(text, 5, 5, false)?.map((item) => item.id)).toEqual(['reference-1', 'reference-2', 'reference-3', 'reference-4', 'reference-5'])
    expect(createAgentReferenceBatch(text, 5, 4, false)).toBeNull()
    expect(createAgentReferenceBatch(text, 5, 5, true)).toBeNull()
    expect(createAgentReferenceBatch('参考每张图，合并成一张作品', 5, 5, false)).toBeNull()
    expect(createAgentReferenceBatch('参考每张图，分析如何生成五张作品', 5, 5, false)).toBeNull()
  })
  it('extracts generated and current input XML reference ids', () => {
    expect(extractAgentReferenceIds('参考 <ref id="round-1-image-2" /> 和 <ref id="round-3-reference-1" />')).toEqual([
      'round-1-image-2',
      'round-3-reference-1',
    ])
  })

  it('resolves previous round image references from visible text', () => {
    const rounds = [
      round({ index: 1, outputTaskIds: ['task-a'] }),
      round({ index: 2, outputTaskIds: ['task-b'] }),
    ]

    expect(resolveAgentPromptImageReferences('参考 @第1轮图2 和 @2轮图1', rounds, [
      task('task-a', ['image-a1', 'image-a2']),
      task('task-b', ['image-b1']),
    ])).toEqual(['image-a2', 'image-b1'])
  })

  it('keeps previous round image numbering stable after a task is removed', () => {
    const rounds = [round({ index: 1, outputTaskIds: ['task-deleted', 'task-live'] })]

    expect(resolveAgentPromptImageReferences('参考 @第1轮图1 和 @第1轮图2', rounds, [
      task('task-live', ['image-live']),
    ])).toEqual(['image-live'])
  })

  it('replaces current hidden mentions with current round reference tags', () => {
    const currentRound = round({ index: 3, inputImageIds: ['image-a', 'image-b'] })

    expect(replaceAgentPromptImageReferencesForApi(
      `把 ${getSelectedImageMentionLabel(1)} 变蓝`,
      currentRound,
      [currentRound],
      [],
    )).toBe('把 <ref id="round-3-reference-2" /> 变蓝')
  })

  it('replaces copied previous round references with current round reference tags', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-a'] })
    const currentRound = round({ index: 2, inputImageIds: ['image-a2'] })

    expect(replaceAgentPromptImageReferencesForApi(
      '参考 @第1轮图2 生成',
      currentRound,
      [firstRound, currentRound],
      [task('task-a', ['image-a1', 'image-a2'])],
    )).toBe('参考 <ref id="round-2-reference-1" /> 生成')
  })

  it('replaces selected previous round reference capsules without leaking markers', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-a'] })
    const currentRound = round({ index: 2, inputImageIds: ['image-a2'] })

    expect(replaceAgentPromptImageReferencesForApi(
      `参考 ${getSelectedTextMentionLabel('@第1轮图2')} 生成`,
      currentRound,
      [firstRound, currentRound],
      [task('task-a', ['image-a1', 'image-a2'])],
    )).toBe('参考 <ref id="round-2-reference-1" /> 生成')
  })

  it('falls back to generated round tags when previous images were not copied', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-a'] })
    const currentRound = round({ index: 2, inputImageIds: [] })

    expect(replaceAgentPromptImageReferencesForApi(
      '参考 @1轮图1 生成',
      currentRound,
      [firstRound, currentRound],
      [task('task-a', ['image-a1'])],
    )).toBe('参考 <ref id="round-1-image-1" /> 生成')
  })

  it('replaces removed previous round references with removed_ref tags', () => {
    const firstRound = round({ index: 1, outputTaskIds: ['task-deleted', 'task-live'] })
    const currentRound = round({ index: 2, inputImageIds: [] })

    expect(replaceAgentPromptImageReferencesForApi(
      '参考 @1轮图1 和 @1轮图2 生成',
      currentRound,
      [firstRound, currentRound],
      [task('task-live', ['image-live'])],
    )).toBe('参考 <removed_ref id="round-1-image-1" /> 和 <ref id="round-1-image-2" /> 生成')
  })
})
