// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import MarkdownRenderer from './MarkdownRenderer'

const MALICIOUS_MARKDOWN = [
  '<script>window.__xss = 1</script>',
  '<img src="x" onerror="window.__xss = 1">',
  '<svg><script>window.__xss = 1</script></svg>',
  '<svg onload="window.__xss = 1"></svg>',
  '<iframe src="https://example.com"></iframe>',
  '<iframe srcdoc="<script>window.__xss = 1</script>"></iframe>',
  '<form action="https://example.com"><button>提交</button></form>',
  '<style>body { display: none }</style>',
  '<object data="https://example.com/x.swf"></object>',
  '<a href="javascript:alert(1)">原始 HTML 链接</a>',
  '<div onclick="window.__xss = 1">点击</div>',
  '<div style="color: red" class="fixed inset-0" id="root">样式</div>',
  '<img src="https://example.com/raw.png" alt="远程">',
  '',
  '[js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [ent](&#106;avascript:alert(1))',
  '[html](data:text/html,<script>alert(1)</script>) [vb](vbscript:msgbox(1))',
  '![img](javascript:alert(1)) ![svg](data:image/svg+xml,<svg onload=alert(1)>)',
  '[ok](https://example.com)',
  '',
  '$\\href{javascript:alert(1)}{点我}$ $\\url{javascript:alert(1)}$ $\\htmlId{x}{y}$ $x^2$',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
].join('\n')

const RAW_TAGS = ['script', 'iframe', 'form', 'style', 'object', 'embed', 'svg foreignObject']

let root: ReturnType<typeof createRoot> | null = null

// 让 React 知道当前在测试环境中使用 act
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 渲染器按需加载，首次转换模块在并行跑测试时可能需要数秒，先预热，渲染时只等组件更新
beforeAll(async () => {
  await Promise.all([import('streamdown'), import('@streamdown/math'), import('react-markdown'), import('remark-gfm')])
}, 60_000)

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function render(content: string, Renderer = MarkdownRenderer, readySelector = '[data-streamdown]') {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Renderer content={content} />))
  // 渲染器按需异步加载，等到输出 Markdown 内容
  const deadline = Date.now() + 10_000
  while (!container.querySelector(readySelector) && Date.now() < deadline) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  }
  expect(container.querySelector(readySelector)).not.toBeNull()
  return container
}

function expectNoExecutableContent(el: HTMLElement) {
  for (const tag of RAW_TAGS) expect(el.querySelector(tag)).toBeNull()
  for (const node of el.querySelectorAll('*')) {
    for (const attr of node.attributes) expect(attr.name.startsWith('on')).toBe(false)
  }
  const urls = [
    ...[...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!),
    ...[...el.querySelectorAll('img[src]')].map((img) => img.getAttribute('src')!),
  ]
  for (const url of urls) expect(url).not.toMatch(/^\s*(javascript|vbscript|data):/i)
}

describe('MarkdownRenderer 安全性', { timeout: 15_000 }, () => {
  it('不渲染原始 HTML、事件属性和危险标签', async () => {
    const el = await render(MALICIOUS_MARKDOWN)

    expectNoExecutableContent(el)
    expect(el.querySelector('img[src="x"]')).toBeNull()
  })

  it('原始 HTML 中的 style 被移除、class 被过滤、id 加上前缀', async () => {
    const el = await render(MALICIOUS_MARKDOWN)

    const div = el.querySelector('#user-content-root')
    expect(div?.textContent).toBe('样式')
    expect(div?.hasAttribute('style')).toBe(false)
    expect(div?.hasAttribute('class')).toBe(false)
    expect(el.querySelector('#root')).toBeNull()
  })

  it('原始 HTML 中的远程图片与 Markdown 图片一样需要点击后加载', async () => {
    const el = await render(MALICIOUS_MARKDOWN)

    expect(el.querySelector('img[src="https://example.com/raw.png"]')).toBeNull()
    const button = el.querySelector<HTMLButtonElement>('[data-markdown-remote-image][title="https://example.com/raw.png"]')
    expect(button?.textContent).toContain('example.com')
    await act(async () => button!.click())
    expect(el.querySelector('img[src="https://example.com/raw.png"]')).not.toBeNull()
  })

  it('链接和图片只放行安全协议', async () => {
    const el = await render(MALICIOUS_MARKDOWN)

    expectNoExecutableContent(el)
    expect(el.querySelector('a[href="https://example.com/"]')).not.toBeNull()
  })

  it('公式不执行 \\href 等需要信任的命令，普通公式正常渲染', async () => {
    const el = await render(MALICIOUS_MARKDOWN)

    expect(el.querySelector('.katex')).not.toBeNull()
    expect(el.querySelector('.katex a')).toBeNull()
    expect(el.querySelector('.katex [id="x"]')).toBeNull()
  })

  it('mermaid 代码块按普通代码显示，不渲染 SVG', async () => {
    const el = await render(MALICIOUS_MARKDOWN)

    expect(el.querySelector('[data-streamdown="mermaid-block"]')).toBeNull()
    expect(el.textContent).toContain('graph TD; A-->B')
  })

  it('外部图片先显示占位、不发出请求，点击后渲染为普通图片且不带下载按钮', async () => {
    const el = await render(['![远程](https://example.com/a.png)', '', '![危险](javascript:alert(1))'].join('\n'), MarkdownRenderer, '[data-markdown-remote-image]')

    expect(el.querySelector('img')).toBeNull()
    const button = el.querySelector<HTMLButtonElement>('[data-markdown-remote-image]')!
    expect(button.textContent).toBe('加载外部图片「远程」（example.com）')
    await act(async () => button.click())
    const img = el.querySelector('img[src="https://example.com/a.png"]')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('alt')).toBe('远程')
    // 原组件会包一层 image-wrapper 并在其中放下载按钮（jsdom 不加载图片，按钮本身不会出现，因此检查包裹层）
    expect(el.querySelector('[data-streamdown="image-wrapper"]')).toBeNull()
    expectNoExecutableContent(el)
  })

  it('同源图片直接显示', async () => {
    const el = await render('![本地](/announcements/cat.png)', MarkdownRenderer, 'img')

    expect(el.querySelector('img[src="/announcements/cat.png"]')).not.toBeNull()
    expect(el.querySelector('[data-markdown-remote-image]')).toBeNull()
  })

  it('Markdown 图片加载失败时显示“图片不可用”', async () => {
    const el = await render('![远程](https://example.com/broken.png)', MarkdownRenderer, '[data-markdown-remote-image]')

    await act(async () => el.querySelector<HTMLButtonElement>('[data-markdown-remote-image]')!.click())
    await act(async () => el.querySelector('img')!.dispatchEvent(new Event('error')))

    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain('图片不可用')
  })
})

describe('MarkdownRenderer 回退到 react-markdown', { timeout: 15_000 }, () => {
  it('不渲染原始 HTML，危险链接被替换', async () => {
    // 让 streamdown 加载失败，走旧浏览器使用的 react-markdown 路径
    vi.resetModules()
    vi.doMock('streamdown', () => {
      throw new Error('streamdown 不可用')
    })
    const { default: LegacyRenderer } = await import('./MarkdownRenderer')
    const el = await render(`${MALICIOUS_MARKDOWN}\n\n![远程](https://example.com/legacy.png)`, LegacyRenderer, '.markdown-renderer p')

    expectNoExecutableContent(el)
    expect(el.querySelector('img[src="https://example.com/legacy.png"]')).toBeNull()
    expect(el.querySelector('[data-markdown-remote-image][title="https://example.com/legacy.png"]')).not.toBeNull()
    expect(el.querySelector('img[src="x"]')).toBeNull()
    expect(el.querySelector('#root')).toBeNull()
    expect(el.querySelector('a[href="https://example.com"]')).not.toBeNull()
    vi.doUnmock('streamdown')
  })
})
