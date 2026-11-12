import type { AgentRound, TaskRecord } from '../types'
import { replaceImageMentionsForApi, stripImageMentionMarkers } from './promptImageMentions'

const AGENT_ROUND_IMAGE_REFERENCE_RE = /@(?:第)?(\d+)轮图(\d+)/g
const AGENT_REF_TAG_RE = /<ref\b[^>]*\bid=(["'])(round-(\d+)-(?:image|reference)-(\d+))\1[^>]*\/?>/g

export const LOCAL_REFERENCE_BATCH_PREFIX = 'local-reference-batch-'

/** 只在用户明确要求逐图生成且数量相符时，绕过文本规划。 */
export function createAgentReferenceBatch(prompt: string, referenceCount: number, count: number | 'auto' | undefined, hasMask: boolean): Array<{ id: string; prompt: string }> | null {
  if (hasMask || referenceCount < 2 || count !== referenceCount) return null
  const text = stripImageMentionMarkers(prompt).trim()
  if (/@(?:图|第?\d+轮图)|<ref\b|拼贴|拼接|合并|融合|组合|整合|对比|分析|搜索|参考历史|不要生成|不生成|无需生成|先别|[?？]/i.test(text)) return null
  if (!/^(?:请\s*)?(?:(?:依次|分别|逐一|逐张|按顺序)\s*(?:根据|按照|参照|参考|基于|用|按)?|(?:根据|按照|参照|参考|基于|用|按))\s*(?:每一?张|各张|每个)\s*(?:上传的|参考)?\s*(?:图|图片|参考图)[^\n]*?(?:生成|制作|绘制|重绘|出图|改成)/u.test(text)) return null
  return Array.from({ length: count }, (_, index) => ({
    id: `reference-${index + 1}`,
    prompt: `本任务对应第 ${index + 1} 张参考图。仅根据本请求附带的一张参考图，制作一张独立完整的图片。\n用户要求：${text}`,
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
