import type { TaskParams } from '../types'
import { canvasToBlob, loadImage } from './canvasImage'
import { blobToDataUrl } from './dataUrl'

export function getContainedImageRect(sourceWidth: number, sourceHeight: number, width: number, height: number) {
  if (![sourceWidth, sourceHeight, width, height].every((value) => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效，无法适配比例')
  const scale = Math.min(width / sourceWidth, height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  return { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight }
}

/** 按选定尺寸完整保留画面，补边而不裁剪或拉伸。 */
export async function fitOutputImage(dataUrl: string, params: Pick<TaskParams, 'size' | 'output_format' | 'output_compression' | 'transparent_output'>): Promise<{ dataUrl: string; changed: boolean }> {
  if (params.size === 'auto') return { dataUrl, changed: false }
  const match = params.size.match(/^(\d+)[x×](\d+)$/i)
  if (!match) throw new Error('目标图片尺寸无效，请重新选择尺寸')
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 33_554_432) throw new Error('目标图片尺寸过大，请选择 4K 或更小的尺寸')
  const source = await loadImage(dataUrl)
  if (source.naturalWidth === width && source.naturalHeight === height) return { dataUrl, changed: false }
  const rect = getContainedImageRect(source.naturalWidth, source.naturalHeight, width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前环境不支持图片尺寸适配，原始图片尚未处理')
  if (!params.transparent_output || params.output_format === 'jpeg') {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height)
  const compression = params.output_compression == null ? undefined : params.output_compression / 100
  const blob = await canvasToBlob(canvas, `image/${params.output_format}`, compression)
  return { dataUrl: await blobToDataUrl(blob), changed: true }
}
