import type { AgentRound, TaskRecord } from '../types'
import { getTaskPromptText, replaceImageMentionsForApi, stripImageMentionMarkers } from './promptImageMentions'
import { getAgentGuidance, normalizeAgentInstructions } from './agentGuidance'
import { excerptText } from './textExcerpt'

const AGENT_ROUND_IMAGE_REFERENCE_RE = /@(?:第)?(\d+)轮图(\d+)/g
const AGENT_REF_TAG_RE = /<ref\b[^>]*\bid=(["'])(round-(\d+)-(?:image|reference)-(\d+))\1[^>]*\/?>/g

export const LOCAL_REFERENCE_BATCH_PREFIX = 'local-reference-batch-'
export const MAX_AGENT_IMAGE_PROMPT_LENGTH = 30_000
export const AGENT_IMAGE_PROMPT_EXCERPT_MARKER = '\n……（生图补充内容已摘录）……\n'
export const AGENT_ORIGINAL_REQUIREMENTS_PREFIX = '本张只生成上方计划的一张独立图片。请用下面的原话核对并保留本张相关的文字、颜色、元素数量、构图和禁止项。其他图片的主题不画进本张，参考图以实际附图为准。\n用户原始要求：\n'
const IMAGE_PROMPT_PROTOCOL_RESERVE = 512
const IMAGE_PROMPT_CONTENT_LIMIT = MAX_AGENT_IMAGE_PROMPT_LENGTH - IMAGE_PROMPT_PROTOCOL_RESERVE
const ORIGINAL_REQUIREMENTS_LIMIT = 2000
const MIN_ORIGINAL_REQUIREMENTS_LENGTH = 256

interface ImagePromptGuidance {
  globalInstructions?: unknown
  conversationInstructions?: unknown
}

export function assertAgentImagePromptLength(prompt: string): void {
  if (prompt.length > IMAGE_PROMPT_CONTENT_LIMIT) {
    throw new Error('图片规划提示词过长，未提交生图请求。请精简本轮要求或拆分图片任务后重试。')
  }
}

/** 原话用于核对细节，图像范围仍由每张图自己的计划决定。 */
export function preserveAgentImageRequirements(plannedPrompt: string, userPrompt: string, referenceCount: number, guidance: ImagePromptGuidance = {}): string {
  const budget = IMAGE_PROMPT_CONTENT_LIMIT
  assertAgentImagePromptLength(plannedPrompt)
  const original = getTaskPromptText(userPrompt, referenceCount).trim()
  const supplements = {
    original: original && !plannedPrompt.includes(original) ? excerptText(original, ORIGINAL_REQUIREMENTS_LIMIT, AGENT_IMAGE_PROMPT_EXCERPT_MARKER) : '',
    conversation: normalizeAgentInstructions(guidance.conversationInstructions),
    global: normalizeAgentInstructions(guidance.globalInstructions),
  }
  const compose = () => [
    plannedPrompt,
    ...(supplements.original ? [`${AGENT_ORIGINAL_REQUIREMENTS_PREFIX}${supplements.original}`] : []),
    getAgentGuidance(supplements.global, supplements.conversation),
  ].filter(Boolean).join('\n\n')
  let prompt = compose()
  for (const key of ['original', 'conversation', 'global'] as const) {
    if (prompt.length <= budget) break
    const minimum = key === 'original' ? Math.min(supplements.original.length, MIN_ORIGINAL_REQUIREMENTS_LENGTH) : 0
    supplements[key] = excerptText(supplements[key], Math.max(minimum, supplements[key].length - (prompt.length - budget)), AGENT_IMAGE_PROMPT_EXCERPT_MARKER)
    prompt = compose()
  }
  assertAgentImagePromptLength(prompt)
  return prompt
}

/** 显式引用优先；漏写标签时沿用本轮上传的参考图。 */
export function getAgentImageReferenceIds(prompt: string, round: AgentRound): string[] {
  const explicit = extractAgentReferenceIds(prompt)
  return [...new Set(explicit.length ? explicit : round.inputImageIds.map((_, index) => getAgentCurrentReferenceId(round, index)))]
}

/** 只在用户明确要求逐图生成且数量相符时，绕过文本规划。 */
export function createAgentReferenceBatch(prompt: string, referenceCount: number, count: number | 'auto' | undefined, hasMask: boolean): Array<{ id: string; prompt: string }> | null {
  if (hasMask || referenceCount < 2 || count !== referenceCount) return null
  const text = stripImageMentionMarkers(prompt).trim()
  if (/@(?:图|第?\d+轮图)|<ref\b|拼贴|拼接|合并|融合|组合|整合|对比|分析|搜索|参考历史|不要生成|不生成|无需生成|先别|[?？]/i.test(text)) return null
  if (!/^(?:请\s*)?(?:(?:依次|分别|逐一|逐张|按顺序)\s*(?:根据|按照|参照|参考|基于|用|按)?|(?:根据|按照|参照|参考|基于|用|按))\s*(?:每一?张|各张|每个)\s*(?:上传的|参考)?\s*(?:图|图片|参考图)[^\n]*?(?:生成|制作|绘制|重绘|出图|改成)/u.test(text)) return null
  return Array.from({ length: count }, (_, index) => ({
    id: `reference-${index + 1}`,
    prompt: `本任务对应第 ${index + 1} 张参考图。仅根据本请求附带的一张参考图，制作一张独立完整的图片。`,
  }))
}

export function getAgentCurrentReferenceId(round: AgentRound, index: number) {
  return `round-${round.index}-reference-${index + 1}`
}

export function getAgentGeneratedImageReferenceId(round: AgentRound, index: number) {
  return `round-${round.index}-image-${index + 1}`
}

export function getAgentReferenceTag(referenceId: string) {
  return `<ref id="${referenceId}" />`
}

export function getAgentRemovedReferenceTag(referenceId: string) {
  return `<removed_ref id="${referenceId}" />`
}

export function collectAgentRoundOutputImageSlots(round: AgentRound, tasks: TaskRecord[]) {
  const slots: Array<string | null> = []
  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task) {
      slots.push(null)
      continue
    }
    slots.push(...task.outputImages)
  }
  return slots
}

export function extractAgentReferenceIds(text: string) {
  return Array.from(text.matchAll(AGENT_REF_TAG_RE), (match) => match[2]).filter((id): id is string => Boolean(id))
}

export function resolveAgentPromptImageReferences(prompt: string, rounds: AgentRound[], tasks: TaskRecord[]) {
  const refs: string[] = []
  for (const match of prompt.matchAll(AGENT_ROUND_IMAGE_REFERENCE_RE)) {
    const roundIndex = Number(match[1]) - 1
    const imageIndex = Number(match[2]) - 1
    const round = rounds[roundIndex]
    if (!round || imageIndex < 0) continue

    const imageId = collectAgentRoundOutputImageSlots(round, tasks)[imageIndex]
    if (imageId) refs.push(imageId)
  }
  return refs
}

export function replaceAgentPromptImageReferencesForApi(
  prompt: string,
  currentRound: AgentRound,
  rounds: AgentRound[],
  tasks: TaskRecord[],
) {
  const withCurrentReferences = replaceImageMentionsForApi(
    prompt,
    currentRound.inputImageIds.length,
    (index) => getAgentReferenceTag(getAgentCurrentReferenceId(currentRound, index)),
  )

  const replaceGeneratedReference = (text: string, roundNumber: string, imageNumber: string) => {
    const roundIndex = Number(roundNumber) - 1
    const imageIndex = Number(imageNumber) - 1
    const sourceRound = rounds[roundIndex]
    if (!sourceRound || imageIndex < 0) return text

    const imageId = collectAgentRoundOutputImageSlots(sourceRound, tasks)[imageIndex]
    if (!imageId) return getAgentRemovedReferenceTag(getAgentGeneratedImageReferenceId(sourceRound, imageIndex))

    const currentReferenceIndex = currentRound.inputImageIds.indexOf(imageId)
    const referenceId = currentReferenceIndex >= 0
      ? getAgentCurrentReferenceId(currentRound, currentReferenceIndex)
      : getAgentGeneratedImageReferenceId(sourceRound, imageIndex)
    return getAgentReferenceTag(referenceId)
  }
  const withAgentReferences = withCurrentReferences.replace(AGENT_ROUND_IMAGE_REFERENCE_RE, replaceGeneratedReference)
  return stripImageMentionMarkers(withAgentReferences)
}
