import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalComputeStatus } from '../ExternalComputeStatus'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  updateUser: vi.fn(),
  currentUser: {
    id: 'user-1',
    email: 'user@example.com',
    displayName: 'User',
    role: 'user',
    authProvider: 'password',
    billingMode: 'platform_credits',
  } as {
    id: string
    email: string
    displayName: string
    role: string
    authProvider: string
    billingMode: string
    grokEnabled?: boolean
  },
}))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    getUser: () => mocks.currentUser,
    fetchWithAuth: mocks.fetchWithAuth,
    updateUser: mocks.updateUser,
  },
}))

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

function response(
  computeSource: Record<string, unknown>,
  user: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return new Response(JSON.stringify({ ok: true, computeSource, user, ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const platformSource = {
  provider: 'foxapi',
  billing_mode: 'platform_credits',
  active: false,
  configured: false,
  status: 'not_configured',
  key_fingerprint: '',
  model_count: 0,
}

describe('ExternalComputeStatus', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset()
    mocks.updateUser.mockReset()
    mocks.updateUser.mockImplementation((patch: Record<string, unknown>) => {
      mocks.currentUser = { ...mocks.currentUser, ...patch }
    })
    mocks.currentUser = {
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      role: 'user',
      authProvider: 'password',
      billingMode: 'platform_credits',
    }
  })

  it('shows one FoxAPI Key mode with GPT and Grok as optional channels', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(response(platformSource, mocks.currentUser, {
      grokComputeSource: {
        provider: 'grok',
        billing_mode: 'platform_credits',
        active: false,
        configured: false,
        status: 'not_configured',
        key_fingerprint: '',
        model_count: 0,
      },
    }))

    render(<ExternalComputeStatus />)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: /平台积分/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /FoxAPI密钥/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^GPT$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^GROK$/ })).not.toBeInTheDocument()

    const gptChannel = screen.getByTestId('compute-channel-gpt')
    const grokChannel = screen.getByTestId('compute-channel-grok')
    expect(within(gptChannel).getByText('GPT')).toBeInTheDocument()
    expect(within(grokChannel).getByText('Grok')).toBeInTheDocument()
    expect(within(grokChannel).getByText('未配置，缺口用积分模型')).toBeInTheDocument()

    fireEvent.click(within(grokChannel).getByRole('button', { name: /配置 Grok/ }))
    expect(screen.getByLabelText('Grok通道密钥')).toBeInTheDocument()
  })

  it('keeps an explicit platform preference when both external channels are configured', async () => {
    const user = {
      ...mocks.currentUser,
      billingMode: 'platform_credits',
      hasApiKey: true,
      apiKeyFingerprint: 'foxkey123456',
      apiKeyStatus: 'active',
      hasGrokApiKey: true,
      grokApiKeyFingerprint: 'grokkey123456',
      grokApiKeyStatus: 'active',
    }
    const foxSource = {
      ...platformSource,
      billing_mode: 'external_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'foxkey123456',
      model_count: 2,
    }
    const grokSource = {
      ...platformSource,
      provider: 'grok',
      billing_mode: 'grok_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'grokkey123456',
      model_count: 3,
    }
    mocks.currentUser = user
    mocks.fetchWithAuth.mockResolvedValueOnce(response(foxSource, user, { grokComputeSource: grokSource }))

    render(<ExternalComputeStatus />)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1))
    expect(screen.getByText('平台积分 · 当前使用平台积分')).toBeInTheDocument()
  })

  it('binds a key to the existing account and activates external compute', async () => {
    const externalUser = {
      ...mocks.currentUser,
      billingMode: 'external_api_key',
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
      apiKeyStatus: 'active',
      foxapiModelCount: 2,
    }
    const externalSource = {
      ...platformSource,
      billing_mode: 'external_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'abcdef123456',
      model_count: 2,
    }
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response(platformSource, mocks.currentUser))
      .mockResolvedValueOnce(response(externalSource, externalUser))

    const result = render(<ExternalComputeStatus />)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1))
    expect(screen.queryByLabelText('FoxAPI密钥')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /FoxAPI密钥/ }))
    const keyInput = screen.getByLabelText('FoxAPI密钥')
    expect(keyInput).toBeInTheDocument()
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput).toHaveAttribute('autocomplete', 'one-time-code')
    expect(keyInput).not.toHaveAttribute('readonly')
    expect(keyInput).toHaveAttribute('data-1p-ignore', 'true')
    expect(keyInput).toHaveAttribute('data-lpignore', 'true')
    expect(keyInput).not.toHaveClass('api-key-input--masked')
    expect(screen.getByRole('link', { name: /前往 FoxAPI 申请/ })).toHaveAttribute('href', 'https://foxapi.cn')
    keyInput.focus()
    expect(keyInput).toHaveFocus()
    fireEvent.change(keyInput, { target: { value: 'fox-secret-key' } })
    expect(keyInput).toHaveClass('api-key-input--concealed')
    expect(screen.getByTestId('api-key-mask')).toBeInTheDocument()
    expect(keyInput).toHaveFocus()
    result.rerender(<ExternalComputeStatus onChanged={() => undefined} />)
    expect(screen.getByLabelText('FoxAPI密钥')).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: /验证并保存/ }))

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2))
    expect(mocks.fetchWithAuth.mock.calls[1][0]).toBe('/api/auth/compute-source/api-key')
    expect(JSON.parse(String(mocks.fetchWithAuth.mock.calls[1][1]?.body))).toEqual({
      api_key: 'fox-secret-key',
      activate: true,
    })
    expect(mocks.updateUser).toHaveBeenLastCalledWith(expect.objectContaining({
      authProvider: 'password',
      billingMode: 'external_api_key',
    }))
    expect(await screen.findByText('算力配置已更新')).toBeInTheDocument()
    expect(screen.getByText('FoxAPI密钥已验证并生效')).toBeInTheDocument()
    expect(screen.getAllByText('2 个模型').length).toBeGreaterThan(0)
    expect(screen.getByText('FoxAPI 账户')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /打开 FoxAPI/ })).toHaveAttribute('href', 'https://foxapi.cn')
  })

  it('binds a Grok key as an optional channel of the same FoxAPI Key mode', async () => {
    const grokUser = {
      ...mocks.currentUser,
      billingMode: 'grok_api_key',
      hasGrokApiKey: true,
      grokApiKeyFingerprint: 'grokkey123456',
      grokApiKeyStatus: 'active',
      grokModelCount: 3,
    }
    const grokSource = {
      provider: 'grok',
      billing_mode: 'grok_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'grokkey123456',
      model_count: 3,
    }
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response(platformSource, mocks.currentUser, { grokComputeSource: {
        provider: 'grok',
        billing_mode: 'platform_credits',
        active: false,
        configured: false,
        status: 'not_configured',
        key_fingerprint: '',
        model_count: 0,
      } }))
      .mockResolvedValueOnce(response(platformSource, grokUser, { grokComputeSource: grokSource }))

    render(<ExternalComputeStatus />)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /配置 Grok/ }))
    const keyInput = screen.getByLabelText('Grok通道密钥')
    fireEvent.change(keyInput, { target: { value: 'grok-secret-key' } })
    fireEvent.click(screen.getByRole('button', { name: /验证并保存/ }))

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2))
    expect(mocks.fetchWithAuth.mock.calls[1][0]).toBe('/api/auth/compute-source/grok-api-key')
    expect(JSON.parse(String(mocks.fetchWithAuth.mock.calls[1][1]?.body))).toEqual({
      api_key: 'grok-secret-key',
      activate: true,
    })
    expect(mocks.updateUser).toHaveBeenLastCalledWith(expect.objectContaining({
      billingMode: 'grok_api_key',
    }))
  })

  it('refreshes the saved FoxAPI catalog without asking the user to enter the key again', async () => {
    const externalSource = {
      ...platformSource,
      billing_mode: 'external_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'abcdef123456',
      model_count: 2,
    }
    const refreshedSource = { ...externalSource, model_count: 5 }
    const externalUser = {
      ...mocks.currentUser,
      billingMode: 'external_api_key',
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
      apiKeyStatus: 'active',
      foxapiModelCount: 2,
    }
    const refreshedUser = { ...externalUser, foxapiModelCount: 5 }
    mocks.currentUser = externalUser
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response(externalSource, externalUser))
      .mockResolvedValueOnce(response(refreshedSource, refreshedUser))

    render(<ExternalComputeStatus />)

    fireEvent.click(await screen.findByTestId('refresh-foxapi-models'))

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2))
    expect(mocks.fetchWithAuth.mock.calls[1][0]).toBe('/api/auth/compute-source/api-key/refresh')
    expect(mocks.fetchWithAuth.mock.calls[1][1]?.method).toBe('POST')
    expect(mocks.updateUser).toHaveBeenLastCalledWith(expect.objectContaining({
      billingMode: 'external_api_key',
      foxapiModelCount: 5,
    }))
    expect(await screen.findByText('模型目录已刷新，可直接选择新模型')).toBeInTheDocument()
  })

  it('hides the Grok channel when the Grok channel is offline', async () => {
    mocks.currentUser = {
      ...mocks.currentUser,
      grokEnabled: false,
    }
    mocks.fetchWithAuth.mockResolvedValueOnce(response(
      platformSource,
      { ...mocks.currentUser, grokEnabled: false },
      { grokEnabled: false },
    ))

    render(<ExternalComputeStatus />)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: /平台积分/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /FoxAPI密钥/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /配置 Grok/ })).not.toBeInTheDocument()
  })

  it('keeps the key input focused when the initial compute-source refresh finishes', async () => {
    let resolveInitialLoad: (value: Response) => void = () => {}
    const cachedExternalUser = {
      ...mocks.currentUser,
      billingMode: 'external_api_key',
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
      apiKeyStatus: 'active',
      foxapiModelCount: 2,
    }
    const serverPlatformUser = {
      ...cachedExternalUser,
      billingMode: 'platform_credits',
    }
    const configuredPlatformSource = {
      ...platformSource,
      configured: true,
      status: 'active',
      key_fingerprint: 'abcdef123456',
      model_count: 2,
    }
    mocks.currentUser = cachedExternalUser
    mocks.fetchWithAuth.mockImplementationOnce(() => new Promise<Response>(resolve => {
      resolveInitialLoad = resolve
    }))

    render(<ExternalComputeStatus />)

    fireEvent.click(screen.getByRole('button', { name: /更换密钥/ }))
    const keyInput = screen.getByLabelText('FoxAPI密钥')
    keyInput.focus()
    expect(keyInput).toHaveFocus()

    resolveInitialLoad(response(configuredPlatformSource, serverPlatformUser))

    await waitFor(() => {
      expect(mocks.updateUser).toHaveBeenLastCalledWith(serverPlatformUser)
      expect(screen.getByLabelText('FoxAPI密钥')).toHaveFocus()
    })
  })

  it('keeps an already verified key inactive until the mode switch is saved', async () => {
    const configuredPlatformSource = {
      ...platformSource,
      configured: true,
      status: 'active',
      key_fingerprint: 'abcdef123456',
      model_count: 2,
    }
    const configuredPlatformUser = {
      ...mocks.currentUser,
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
      apiKeyStatus: 'active',
      foxapiModelCount: 2,
    }
    const externalSource = {
      ...configuredPlatformSource,
      billing_mode: 'external_api_key',
      active: true,
    }
    const externalUser = {
      ...configuredPlatformUser,
      billingMode: 'external_api_key',
    }
    mocks.currentUser = configuredPlatformUser
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response(configuredPlatformSource, configuredPlatformUser))
      .mockResolvedValueOnce(response(externalSource, externalUser))

    render(<ExternalComputeStatus />)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1))
    expect(screen.queryByLabelText('FoxAPI密钥')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /FoxAPI密钥/ }))

    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1)
    expect(screen.getByText('切换尚未保存')).toBeInTheDocument()
    expect(screen.queryByLabelText('FoxAPI密钥')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /保存并切换/ }))

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2))
    expect(mocks.fetchWithAuth.mock.calls[1][0]).toBe('/api/auth/compute-source')
    expect(JSON.parse(String(mocks.fetchWithAuth.mock.calls[1][1]?.body))).toEqual({
      mode: 'external_api_key',
    })
    expect(screen.queryByText('切换尚未保存')).not.toBeInTheDocument()
  })

  it('aggregates GPT and Grok model counts in FoxAPI Key mode', async () => {
    const foxSource = {
      ...platformSource,
      billing_mode: 'external_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'foxkey123456',
      model_count: 7,
    }
    const grokSource = {
      provider: 'grok',
      billing_mode: 'grok_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'grokkey123456',
      model_count: 59,
    }
    const user = {
      ...mocks.currentUser,
      billingMode: 'external_api_key',
      hasApiKey: true,
      apiKeyFingerprint: 'foxkey123456',
      apiKeyStatus: 'active',
      hasGrokApiKey: true,
      grokApiKeyFingerprint: 'grokkey123456',
      grokApiKeyStatus: 'active',
    }
    mocks.currentUser = user
    mocks.fetchWithAuth.mockResolvedValueOnce(response(foxSource, user, { grokComputeSource: grokSource }))

    render(<ExternalComputeStatus />)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1))
    expect(screen.getByText('FoxAPI密钥 · Key · 66 个模型')).toBeInTheDocument()
    expect(screen.getByText('66 个模型')).toBeInTheDocument()
  })

  it('keeps platform credits inactive until the mode switch is saved', async () => {
    const externalUser = {
      ...mocks.currentUser,
      billingMode: 'external_api_key',
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
      apiKeyStatus: 'active',
      foxapiModelCount: 2,
    }
    const externalSource = {
      ...platformSource,
      billing_mode: 'external_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'abcdef123456',
      model_count: 2,
    }
    const platformWithKeySource = {
      ...externalSource,
      billing_mode: 'platform_credits',
      active: false,
    }
    const platformWithKeyUser = {
      ...externalUser,
      billingMode: 'platform_credits',
    }
    mocks.currentUser = externalUser
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response(externalSource, externalUser))
      .mockResolvedValueOnce(response(platformWithKeySource, platformWithKeyUser))

    render(<ExternalComputeStatus />)

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /平台积分/ }))

    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1)
    expect(screen.getByText('切换尚未保存')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /保存并切换/ }))

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2))
    expect(JSON.parse(String(mocks.fetchWithAuth.mock.calls[1][1]?.body))).toEqual({
      mode: 'platform_credits',
    })
    expect(screen.queryByText('切换尚未保存')).not.toBeInTheDocument()
  })

  it('disconnects a configured key and returns to platform credits', async () => {
    const externalUser = {
      ...mocks.currentUser,
      billingMode: 'external_api_key',
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
      apiKeyStatus: 'active',
      foxapiModelCount: 2,
    }
    const externalSource = {
      ...platformSource,
      billing_mode: 'external_api_key',
      active: true,
      configured: true,
      status: 'active',
      key_fingerprint: 'abcdef123456',
      model_count: 2,
    }
    const disconnectedUser = {
      ...mocks.currentUser,
      billingMode: 'platform_credits',
      hasApiKey: false,
      apiKeyFingerprint: '',
      apiKeyStatus: null,
      foxapiModelCount: 0,
    }
    mocks.currentUser = externalUser
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response(externalSource, externalUser))
      .mockResolvedValueOnce(response(platformSource, disconnectedUser))

    render(<ExternalComputeStatus />)

    fireEvent.click(await screen.findByRole('button', { name: /更换密钥/ }))
    fireEvent.click(screen.getByRole('button', { name: /解除绑定/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认解除/ }))

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2))
    expect(mocks.fetchWithAuth.mock.calls[1][0]).toBe('/api/auth/compute-source/api-key')
    expect(mocks.fetchWithAuth.mock.calls[1][1]?.method).toBe('DELETE')
    expect(mocks.updateUser).toHaveBeenLastCalledWith(expect.objectContaining({
      authProvider: 'password',
      billingMode: 'platform_credits',
      hasApiKey: false,
    }))
  })
})
