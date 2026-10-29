import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('柒柒更新来源', () => {
  it('未配置发布仓库时不构造上游更新地址', async () => {
    vi.stubEnv('VITE_RELEASE_REPO', '')
    vi.resetModules()
    const updates = await import('./releaseUpdates')
    expect(updates.RELEASE_REPO).toBe('')
    expect(updates.RELEASES_PAGE_URL).toBe('')
    expect(() => updates.getReleasesApiUrl(1)).toThrow('尚未配置柒柒的更新仓库')
    expect(updates.LICENSE_URL).toContain('CookSleep/gpt_image_playground/blob/main/LICENSE')
  })

  it('仅从部署者指定的仓库获取发布信息', async () => {
    vi.stubEnv('VITE_RELEASE_REPO', 'qiqi-owner/qiqi')
    vi.resetModules()
    const updates = await import('./releaseUpdates')
    expect(updates.getReleasesApiUrl(2)).toBe('https://api.github.com/repos/qiqi-owner/qiqi/releases?per_page=10&page=2')
    expect(updates.RELEASES_PAGE_URL).toBe('https://github.com/qiqi-owner/qiqi/releases')
    expect(updates.parseReleasePage([{ tag_name: 'v1.0.1', html_url: 'http://example.com/unsafe' }]).releases[0]?.url)
      .toBe('https://github.com/qiqi-owner/qiqi/releases/tag/v1.0.1')
  })

  it('拒绝将任意地址当作发布仓库', async () => {
    vi.stubEnv('VITE_RELEASE_REPO', 'https://example.com/releases')
    vi.resetModules()
    const updates = await import('./releaseUpdates')
    expect(updates.RELEASE_REPO).toBe('')
  })
})
