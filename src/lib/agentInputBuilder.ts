import type { AgentConversation, AgentMessage, AgentRound, ResponsesOutputItem, TaskRecord } from '../types'
import { getAgentRoundPath } from './agentConversationState'
import { getTaskPromptText } from './promptImageMentions'
import {
  collectAgentRoundOutputImageSlots,
  AGENT_ORIGINAL_REQUIREMENTS_PREFIX,
  extractAgentReferenceIds,
  getAgentCurrentReferenceId,
  getAgentGeneratedImageReferenceId,
  replaceAgentPromptImageReferencesForApi,
} from './agentImageReferences'
import { getAgentRoundResponseOutput, sanitizeResponseOutputForInput } from './agentResponseState'
import { excerptText } from './textExcerpt'

type LoadImage = (id: string) => Promise<string | null | undefined>

const FULL_HISTORY_ROUNDS = 6
const HISTORY_TEXT_BUDGET = 48_000
const HISTORY_IMAGE_LIMIT = 4
const HISTORY_IMAGE_BUDGET = 8 * 1024 * 1024
const REQUIRED_IMAGE_BUDGET = 32 * 1024 * 1024
const CURRENT_TEXT_LIMIT = 96_000
const CONTINUATION_TEXT_LIMIT = 192_000
const HISTORY_EXCERPT_LENGTH = 1000
const HISTORY_IMAGE_DESCRIPTION_LENGTH = 200
const ATTACHED_IMAGE_DESCRIPTION_LENGTH = 1200
const CONTEXT_NOTICE_RESERVE = 1024

interface InputReferenceItem {
  role: string
  content: Array<{ type: string; text?: string; image_url?: string }>
}

interface BuildAgentApiInputOptions {
  conversation: AgentConversation
  currentRound: AgentRound
  tasks: TaskRecord[]
  loadImage: LoadImage
  onContextCompacted?: (notice: string) => void
}

interface BuildAgentContinuationInputOptions {
  baseInput: unknown[]
  currentRound: AgentRound
  tasks: TaskRecord[]
  currentRoundOutput: ResponsesOutputItem[]
  functionCallOutputs?: ResponsesOutputItem[]
  batchTaskIds: string[]
  toolCallsUsed: number
  maxToolCalls: number
  loadImage: LoadImage
  onContextCompacted?: (notice: string) => void
}

async function createUserInputItem(
  conversation: AgentConversation,
  round: AgentRound,
  message: AgentMessage,
  tasks: TaskRecord[],
  loadImage: LoadImage,
) {
  const imageDataUrls: string[] = []
  for (const id of round.inputImageIds) {
    const dataUrl = await loadImage(id)
    if (dataUrl) imageDataUrls.push(dataUrl)
  }
  const rounds = getAgentRoundPath(conversation, round.id)
  const text = replaceAgentPromptImageReferencesForApi(message.content, round, rounds, tasks)
  const referenceText = round.inputImageIds.length > 0
    ? `\n\n<available_refs>${round.inputImageIds.map((_, index) => `\n  <ref id="${getAgentCurrentReferenceId(round, index)}" />`).join('')}\n</available_refs>`
    : ''
  return {
    role: 'user',
    content: [
      { type: 'input_text', text: `${text}${referenceText}` },
      ...imageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
    ],
  }
}

function escapeXmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function createGeneratedImageReferencePart(round: AgentRound, task: TaskRecord, imageIndex: number, maxLength: number) {
  const planned = typeof task.agentPlannedPrompt === 'string' ? task.agentPlannedPrompt
    : (typeof task.prompt === 'string' ? task.prompt : '').split(`\n\n${AGENT_ORIGINAL_REQUIREMENTS_PREFIX}`)[0].split('\n\n固定创作设定：')[0]
  const prompt = getTaskPromptText(planned, task.inputImageIds.length).replace(/\s+/g, ' ').trim()
  const truncatedPrompt = excerptText(prompt, maxLength, '…')
  const promptAttribute = truncatedPrompt ? ` prompt="${escapeXmlAttribute(truncatedPrompt)}"` : ''
  return {
    type: 'input_text',
    text: `<ref id="${getAgentGeneratedImageReferenceId(round, imageIndex)}"${promptAttribute} />`,
  }
}

async function createGeneratedImagesInputItem(round: AgentRound, tasks: TaskRecord[], loadImage: LoadImage): Promise<InputReferenceItem | null> {
  const content: Array<{ type: string; text?: string; image_url?: string }> = []
  let imageIndex = 0
  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task) {
      content.push({ type: 'input_text', text: `<removed_ref id="${getAgentGeneratedImageReferenceId(round, imageIndex)}" />` })
      imageIndex += 1
      continue
    }
    for (const imageId of task.outputImages) {
      const dataUrl = await loadImage(imageId)
      if (dataUrl) content.push({ type: 'input_image', image_url: dataUrl })
      content.push(createGeneratedImageReferencePart(round, task, imageIndex, dataUrl ? ATTACHED_IMAGE_DESCRIPTION_LENGTH : HISTORY_IMAGE_DESCRIPTION_LENGTH))
      imageIndex += 1
    }
  }
  return content.length > 0 ? { role: 'user', content } : null
}

async function createBatchImagesInputItem(round: AgentRound, tasks: TaskRecord[], batchTaskIds: string[], loadImage: LoadImage) {
  const content: Array<{ type: string; text?: string; image_url?: string }> = []
  const batchIds = new Set(batchTaskIds)
  let imageIndex = 0
  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task) { imageIndex += 1; continue }
    for (const imageId of task.outputImages) {
      if (batchIds.has(taskId) && task.status === 'done') {
        const dataUrl = await loadImage(imageId)
        if (dataUrl) content.push({ type: 'input_image', image_url: dataUrl })
        content.push(createGeneratedImageReferencePart(round, task, imageIndex, dataUrl ? ATTACHED_IMAGE_DESCRIPTION_LENGTH : HISTORY_IMAGE_DESCRIPTION_LENGTH))
      }
      imageIndex += 1
    }
  }
  return content.length > 0 ? { role: 'user', content } : null
}

function createAssistantFallbackItem(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }
}

function getHistoryAssistantItems(conversation: AgentConversation, round: AgentRound, tasks: TaskRecord[]): unknown[] {
  const output = getAgentRoundResponseOutput(round, tasks)
  if (output?.length) {
    const sanitized = sanitizeResponseOutputForInput(output)
    if (sanitized.length > 0) return sanitized
  }
  const assistantMessage = conversation.messages.find((message) => message.id === round.assistantMessageId)
  return [createAssistantFallbackItem(assistantMessage?.content || (output?.length ? '图像已生成。' : '[No text response]'))]
}

function serializedTextLength(input: unknown): number {
  return JSON.stringify(input, (key, value: unknown) => key === 'image_url' ? '' : value).length
}

function getHistoryExcerpt(text: string): string {
  return excerptText(text, HISTORY_EXCERPT_LENGTH)
}

function getAssistantExcerpt(conversation: AgentConversation, round: AgentRound): string {
  const text = conversation.messages.find((message) => message.id === round.assistantMessageId)?.content
  return text ? getHistoryExcerpt(text) : '本轮没有保存文字回复。'
}

async function loadContextImages(requiredIds: Set<string>, optionalIds: string[], loadImage: LoadImage): Promise<Map<string, string>> {
  const images = new Map<string, string>()
  let requiredSize = 0
  for (const id of requiredIds) {
    const dataUrl = await loadImage(id)
    if (!dataUrl) throw new Error('本轮上传或明确引用的图片已无法读取，请重新上传或选择可用图片后发送。')
    requiredSize += dataUrl.length
    if (requiredSize > REQUIRED_IMAGE_BUDGET) {
      throw new Error('本轮上传或明确引用的图片过大，编码后总量超过 32 MiB。请减少参考图，或缩小图片后重新发送；本地原图和历史记录未改动。')
    }
    images.set(id, dataUrl)
  }
  let optionalSize = 0
  let optionalCount = 0
  const recentIds = [...new Set(optionalIds)].filter((id) => !requiredIds.has(id)).slice(0, HISTORY_IMAGE_LIMIT)
  for (const id of recentIds) {
    if (optionalCount >= HISTORY_IMAGE_LIMIT) break
    const dataUrl = await loadImage(id)
    if (!dataUrl || optionalSize + dataUrl.length > HISTORY_IMAGE_BUDGET) continue
    images.set(id, dataUrl)
    optionalSize += dataUrl.length
    optionalCount += 1
  }
  return images
}

export async function buildAgentApiInput(options: BuildAgentApiInputOptions): Promise<unknown[]> {
  const input: unknown[] = []
  const rounds = getAgentRoundPath(options.conversation, options.currentRound.id)
  const history = rounds.filter((round) => round.id !== options.currentRound.id)
  const currentMessage = options.conversation.messages.find((message) => message.id === options.currentRound.userMessageId)
  if (!currentMessage) return input
  if (currentMessage.content.length > CURRENT_TEXT_LIMIT) {
    throw new Error('本轮文字超过 96,000 字符，请拆分为较短的消息后发送；当前草稿和历史记录未删减。')
  }
  const currentText = replaceAgentPromptImageReferencesForApi(currentMessage.content, options.currentRound, rounds, options.tasks)
  const explicitRefs = new Set(extractAgentReferenceIds(currentText))
  const requiredIds = new Set(options.currentRound.inputImageIds)
  const historyImageIds: string[] = []
  for (const round of history) {
    for (const [index, imageId] of round.inputImageIds.entries()) {
      historyImageIds.push(imageId)
      if (explicitRefs.has(getAgentCurrentReferenceId(round, index))) requiredIds.add(imageId)
    }
    for (const [index, imageId] of collectAgentRoundOutputImageSlots(round, options.tasks).entries()) {
      if (!imageId) continue
      historyImageIds.push(imageId)
      if (explicitRefs.has(getAgentGeneratedImageReferenceId(round, index))) requiredIds.add(imageId)
    }
  }
  const images = await loadContextImages(requiredIds, [...historyImageIds].reverse(), options.loadImage)
  const includedImages = new Set(images.keys())
  const sentImages = new Set<string>()
  const loadHistoryImage: LoadImage = async (id) => {
    if (options.currentRound.inputImageIds.includes(id) || sentImages.has(id)) return undefined
    const dataUrl = images.get(id)
    if (dataUrl) sentImages.add(id)
    return dataUrl
  }
  const currentInput = await createUserInputItem(options.conversation, options.currentRound, currentMessage, options.tasks, async (id) => images.get(id))
  const historyBudget = Math.max(0, Math.min(HISTORY_TEXT_BUDGET, CURRENT_TEXT_LIMIT + HISTORY_TEXT_BUDGET - serializedTextLength([currentInput]) - CONTEXT_NOTICE_RESERVE))
  const referenceBlocks = new Map<string, InputReferenceItem[]>()
  for (const round of history) {
    const items: InputReferenceItem[] = []
    const referenceContent: InputReferenceItem['content'] = []
    for (const [index, id] of round.inputImageIds.entries()) {
      const dataUrl = await loadHistoryImage(id)
      if (dataUrl) referenceContent.push({ type: 'input_image', image_url: dataUrl })
      referenceContent.push({ type: 'input_text', text: `<ref id="${getAgentCurrentReferenceId(round, index)}" />` })
    }
    if (referenceContent.length > 0) items.push({ role: 'user', content: referenceContent })
    const imagesItem = await createGeneratedImagesInputItem(round, options.tasks, loadHistoryImage)
    if (imagesItem) items.push(imagesItem)
    referenceBlocks.set(round.id, items)
  }
  const referenceItems = [...referenceBlocks.values()].flat()
  let referenceTextSize = serializedTextLength(referenceItems)
  let compactedDescriptions = 0
  // 描述与历史文字共用预算，较旧描述先让出空间；图片编号始终保留。
  for (const part of referenceItems.flatMap((item) => item.content)) {
    if (referenceTextSize <= historyBudget / 2) break
    if (!part.text?.startsWith('<ref id=') || !part.text.includes(' prompt="')) continue
    const previousSize = serializedTextLength(part)
    part.text = part.text.replace(/ prompt="[^"]*"/, '')
    referenceTextSize -= previousSize - serializedTextLength(part)
    compactedDescriptions += 1
  }
  const historyBlocks = new Map<string, unknown[]>()
  let remainingText = Math.max(0, historyBudget - referenceTextSize)
  let compactedRounds = 0
  for (const [reverseIndex, round] of [...history].reverse().entries()) {
    const userMessage = options.conversation.messages.find((message) => message.id === round.userMessageId)
    if (!userMessage) continue
    let items: unknown[] = [
      await createUserInputItem(options.conversation, round, userMessage, options.tasks, async () => undefined),
      ...getHistoryAssistantItems(options.conversation, round, options.tasks),
    ]
    if (reverseIndex >= FULL_HISTORY_ROUNDS || serializedTextLength(items) > remainingText) {
      compactedRounds += 1
      items = [
        { role: 'user', content: [{ type: 'input_text', text: `第 ${round.index} 轮用户消息摘录（可能不完整）：\n${getHistoryExcerpt(userMessage.content)}` }] },
        createAssistantFallbackItem(`第 ${round.index} 轮助手回复摘录（可能不完整）：\n${getAssistantExcerpt(options.conversation, round)}`),
      ]
    }
    const size = serializedTextLength(items)
    if (size <= remainingText) {
      historyBlocks.set(round.id, items)
      remainingText -= size
    }
  }
  for (const round of history) {
    const block = historyBlocks.get(round.id)
    if (block) input.push(...block)
    input.push(...(referenceBlocks.get(round.id) ?? []))
  }
  const omittedImages = new Set(historyImageIds.filter((id) => !includedImages.has(id))).size
  if (compactedRounds > 0 || omittedImages > 0 || compactedDescriptions > 0) {
    const notice = [
      compactedRounds > 0 ? `${compactedRounds} 轮较早或过长的历史文字已按预算摘录或省略` : '',
      omittedImages > 0 ? `${omittedImages} 张历史图片未附图片内容，仍保留编号，可继续引用` : '',
      compactedDescriptions > 0 ? `${compactedDescriptions} 张较旧历史图已省略描述，编号仍可引用` : '',
      '完整记录仍保留在本机；需要旧细节时请重新说明或引用图片。',
    ].filter(Boolean).join('；')
    options.onContextCompacted?.(notice)
    input.push({ role: 'user', content: [{ type: 'input_text', text: `上下文范围说明：${notice}` }] })
  }
  input.push(currentInput)
  if (serializedTextLength(input) > CURRENT_TEXT_LIMIT + HISTORY_TEXT_BUDGET) {
    throw new Error('历史描述已压缩，但本轮文字和图片编号仍超过请求预算。请拆分本轮消息，或新建对话并选择需要的图片；完整历史记录已保留。')
  }
  return input
}

export async function buildAgentContinuationInput(options: BuildAgentContinuationInputOptions): Promise<unknown[]> {
  const functionCallOutputIds = new Set((options.functionCallOutputs ?? [])
    .filter((item) => item.type === 'function_call_output' && item.call_id)
    .map((item) => item.call_id!))
  const currentRoundOutput = options.currentRoundOutput.filter(
    (item) => item.type !== 'function_call_output' || !item.call_id || !functionCallOutputIds.has(item.call_id),
  )
  const input = [
    ...options.baseInput,
    ...sanitizeResponseOutputForInput(currentRoundOutput, { allowPendingFunctionCalls: true }),
    ...(options.functionCallOutputs ?? []),
  ]
  if (serializedTextLength(input) > CONTINUATION_TEXT_LIMIT) {
    throw new Error('本轮连续生成的上下文过长，已停止追加请求。已完成的图片已保留，请发送一条新消息继续，或另建对话并引用需要的图片。')
  }
  const batchImageIds = options.batchTaskIds.flatMap((id) => options.tasks.find((task) => task.id === id && task.status === 'done')?.outputImages ?? [])
  const batchImages = await loadContextImages(new Set(), [...batchImageIds].reverse(), options.loadImage)
  const batchImagesItem = await createBatchImagesInputItem(options.currentRound, options.tasks, options.batchTaskIds, async (id) => batchImages.get(id))
  if (batchImagesItem) input.push(batchImagesItem)
  const omittedImages = new Set(batchImageIds.filter((id) => !batchImages.has(id))).size
  if (omittedImages > 0) {
    const notice = `本轮图片较多，续写时有 ${omittedImages} 张图片仅附引用和提示词；图片文件均保留，可继续明确引用需要的图片。`
    options.onContextCompacted?.(notice)
    input.push({ role: 'user', content: [{ type: 'input_text', text: `上下文范围说明：${notice}` }] })
  }

  const newImageRefs = collectAgentRoundOutputImageSlots(options.currentRound, options.tasks)
    .map((imageId, index) => imageId ? `<ref id="${getAgentGeneratedImageReferenceId(options.currentRound, index)}" />` : null)
    .filter((ref): ref is string => Boolean(ref))
  const lines = ['[System] The app has saved your generated outputs and is continuing the same Agent turn.']
  if (newImageRefs.length > 0) {
    lines.push(`The following image ref ids are now available for you to reference in subsequent image_generation prompts: ${newImageRefs.join(', ')}`)
  }
  lines.push(
    'Continue generating. Do NOT repeat what you already said in earlier responses.',
    'If you still need another round after this (e.g. more dependent images), call continue_generation.',
    `Tool-call budget: ${options.toolCallsUsed}/${options.maxToolCalls} used.`,
  )
  input.push({
    role: 'user',
    content: [{ type: 'input_text', text: lines.join('\n') }],
  })
  if (serializedTextLength(input) > CONTINUATION_TEXT_LIMIT) {
    throw new Error('本轮连续生成的上下文过长，已停止追加请求。已完成的图片已保留，请发送一条新消息继续，或另建对话并引用需要的图片。')
  }
  return input
}
