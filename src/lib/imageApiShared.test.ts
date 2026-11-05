import { describe, expect, it, vi } from 'vitest'
import { formatApiErrorMessage, getApiErrorMessage } from './imageApiShared'

const gatewayHtml = '<html>\n<head><title>504 Gateway Time-out</title></head>\n<body><center><h1>504 Gateway Time-out</h1></center><hr><center>openresty</center></body></html>'

describe('接口错误提示', () => {
  it('将截图中的 504 错误页转成中文，保留网关状态和重试说明', async () => {
    const response = new Response(gatewayHtml, { status: 504, headers: { 'Content-Type': 'text/html' } })
    const clone = vi.spyOn(response, 'clone')
    const message = await getApiErrorMessage(response)
    expect(message).toContain('接口网关等待上游响应超时（HTTP 504）')
    expect(message).toContain('不受本机超时设置控制')
    expect(message).toContain('原请求可能仍在服务端处理')
    expect(message).not.toMatch(/<html>|openresty/)
    expect(clone).not.toHaveBeenCalled()
  })

  it.each([502, 503, 504, 524])('HTTP %s 的空响应和 JSON 错误都能识别', async (status) => {
    for (const body of ['', JSON.stringify({ error: { message: gatewayHtml } })]) {
      const message = await getApiErrorMessage(new Response(body, { status }))
      expect(message).toContain(`HTTP ${status}`)
      expect(message).not.toContain('<html>')
    }
  })

  it('历史 HTML 只在显示时转换，重复格式化结果一致', () => {
    const message = formatApiErrorMessage(gatewayHtml)
    expect(message).toContain('HTTP 504')
    expect(formatApiErrorMessage(message)).toBe(message)
    expect(gatewayHtml).toContain('<html>')
  })

  it('非网关错误不把尺寸和请求编号误判为 504', () => {
    expect(formatApiErrorMessage('图片宽度 504 不受支持')).toBe('图片宽度 504 不受支持')
    expect(formatApiErrorMessage('request id: 504')).toBe('request id: 504')
  })

  it('网关 JSON 错误保留服务商给出的诊断信息', async () => {
    const message = await getApiErrorMessage(new Response(JSON.stringify({ detail: '上游暂不可用' }), { status: 502 }))
    expect(message).toContain('HTTP 502')
    expect(message).toContain('服务商返回：上游暂不可用')
    expect(formatApiErrorMessage(message)).toBe(message)
  })

  it.each([
    [{ error: { message: 'Key 已过期' } }, 'Key 已过期'],
    [{ error: '模型不可用' }, '模型不可用'],
    [{ message: '账户额度不足' }, '账户额度不足'],
    [{ detail: ['字段不正确', { field: 'size' }] }, '字段不正确\n{"field":"size"}'],
    [{ error: { message: { nested: true } } }, 'HTTP 400'],
    [null, 'HTTP 400'],
    ['错误格式', 'HTTP 400'],
  ])('兼容 JSON 错误格式：%j', async (payload, message) => {
    expect(await getApiErrorMessage(new Response(JSON.stringify(payload), { status: 400 }))).toBe(message)
  })

  it('保留普通文本错误，错误页面和读取失败则显示 HTTP 状态', async () => {
    expect(await getApiErrorMessage(new Response('模型不支持', { status: 400 }))).toBe('模型不支持')
    expect(await getApiErrorMessage(new Response('<!doctype html><html>登录页面</html>', { status: 403 }))).toContain('错误页面（HTTP 403）')
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError('断流')) } })
    expect(await getApiErrorMessage(new Response(body, { status: 504 }))).toContain('HTTP 504')
  })
})
