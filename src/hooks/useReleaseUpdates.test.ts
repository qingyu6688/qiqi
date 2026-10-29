import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/platform', () => ({ apiFetch: vi.fn() }))
vi.mock('../lib/localRecord', () => ({ readLocal: vi.fn(() => null), writeLocal: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('未发布的柒柒版本', () => {
  it('检查更新及加载历史都不会请求原项目', async () => {
    vi.stubEnv('VITE_RELEASE_REPO', '')
    vi.resetModules()
    const { apiFetch } = await import('../lib/platform')
    const updates = await import('./useReleaseUpdates')
    expect(await updates.checkForUpdates()).toBeUndefined()
    await updates.loadOlderReleases()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(updates.useReleaseUpdates.getState().releases).toEqual([])
  })
})
