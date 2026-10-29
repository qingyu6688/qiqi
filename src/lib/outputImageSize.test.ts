import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { loadImage, canvasToBlob } from './canvasImage'
import { fitOutputImage, getContainedImageRect } from './outputImageSize'

vi.mock('./canvasImage', () => ({ loadImage: vi.fn(), canvasToBlob: vi.fn() }))
vi.mock('./dataUrl', () => ({ blobToDataUrl: vi.fn(async () => 'data:image/png;base64,fitted') }))
const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: 'low' }
const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
  canvas.getContext.mockReturnValue(context)
  vi.mocked(canvasToBlob).mockResolvedValue(new Blob(['fitted'], { type: 'image/png' }))
})
afterEach(() => vi.unstubAllGlobals())

describe('完整保留内容的尺寸适配', () => {
  it.each([[1024, 801, 1024, 768], [1024, 768, 1280, 720], [1600, 900, 720, 1280], [768, 1024, 1024, 768]])('从 %s×%s 适配为 %s×%s 时不裁剪、不拉伸', (sw, sh, width, height) => {
    const rect = getContainedImageRect(sw, sh, width, height)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(height)
    expect(rect.width / rect.height).toBeCloseTo(sw / sh, 10)
    expect(Math.min(rect.x, rect.y)).toBeCloseTo(0, 10)
  })

  it('把接口返回的 1024×801 海报适配为精确的 1024×768，并保存完整画面', async () => {
    const image = { naturalWidth: 1024, naturalHeight: 801 } as HTMLImageElement
    vi.mocked(loadImage).mockResolvedValue(image)
    const result = await fitOutputImage('raw', { ...DEFAULT_PARAMS, size: '1024x768' })
    expect(canvas).toMatchObject({ width: 1024, height: 768 })
    const [, x, y, width, height] = context.drawImage.mock.calls[0]
    expect(x).toBeGreaterThan(0)
    expect(y).toBe(0)
    expect(height).toBe(768)
    expect(width / height).toBeCloseTo(1024 / 801, 10)
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1024, 768)
    expect(result).toEqual({ dataUrl: 'data:image/png;base64,fitted', changed: true })
  })

  it('透明图片的补边保持透明', async () => {
    vi.mocked(loadImage).mockResolvedValue({ naturalWidth: 1024, naturalHeight: 801 } as HTMLImageElement)
    await fitOutputImage('raw', { ...DEFAULT_PARAMS, size: '1024x768', transparent_output: true })
    expect(context.fillRect).not.toHaveBeenCalled()
    expect(context.drawImage).toHaveBeenCalledOnce()
  })

  it('自动尺寸不处理；已符合尺寸的图片保持原始编码', async () => {
    expect(await fitOutputImage('raw', DEFAULT_PARAMS)).toEqual({ dataUrl: 'raw', changed: false })
    expect(loadImage).not.toHaveBeenCalled()
    vi.mocked(loadImage).mockResolvedValue({ naturalWidth: 1024, naturalHeight: 768 } as HTMLImageElement)
    expect(await fitOutputImage('raw', { ...DEFAULT_PARAMS, size: '1024x768' })).toEqual({ dataUrl: 'raw', changed: false })
    expect(canvasToBlob).not.toHaveBeenCalled()
  })

  it('目标过大或无法创建画布时明确报错，不能将错误比例标为成功', async () => {
    await expect(fitOutputImage('raw', { ...DEFAULT_PARAMS, size: '99999x99999' })).rejects.toThrow('尺寸过大')
    vi.mocked(loadImage).mockResolvedValue({ naturalWidth: 1024, naturalHeight: 801 } as HTMLImageElement)
    canvas.getContext.mockReturnValueOnce(null as unknown as typeof context)
    await expect(fitOutputImage('raw', { ...DEFAULT_PARAMS, size: '1024x768' })).rejects.toThrow('不支持图片尺寸适配')
  })
})
