import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreativeSkillImportDialog } from '../CreativeSkillImportDialog'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
}))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: { fetchWithAuth: mocks.fetchWithAuth },
}))

const candidate = {
  name: '电影叙事配方',
  visual_summary: '用真实光源和空间压力组织电影画面。',
  style_tags: ['电影感', '叙事'],
  composition: '前景遮挡，中景行动，远景结果。',
  lighting: '单一窗光。',
  palette: ['炭黑', '灰蓝'],
  materials: '旧木与粗布。',
  camera: '50mm 变形镜头。',
  negative_prompt: '霓虹，水印',
  execution_instructions: '完整执行角色、空间与真实光源规则。',
  source_name: 'Cinema Skill',
  source_url: 'https://github.com/example/cinema-skill',
  preview_url: '/creative-library/cinema.webp',
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('CreativeSkillImportDialog', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset()
  })

  it('reviews a GitHub recipe and creates it from the approved candidate', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(response({
        accepted: true,
        review_token: 'review-token-1',
        candidate,
        review: {
          category: 'image_generation',
          confidence: 0.94,
          checks: [
            { id: 'style', label: '包含可执行视觉规则', passed: true },
            { id: 'unsafe', label: '不包含危险脚本', passed: true },
          ],
          warnings: ['原仓库未提供预览图，将使用配方默认封面。'],
        },
        cleanup: { temporary_upload_deleted: true },
      }))
      .mockResolvedValueOnce(response({
        item: {
          id: 'personal-cinema-1',
          name: candidate.name,
          module: 'TEXT_TO_IMAGE',
          description: candidate.visual_summary,
          prompt_template: candidate.composition,
          execution_instructions: candidate.execution_instructions,
          tags: candidate.style_tags,
          preview_url: candidate.preview_url,
          enabled: true,
          revision: 1,
          is_personal: true,
        },
        created: true,
        duplicate: false,
      }))
    const onImported = vi.fn()

    render(<CreativeSkillImportDialog open isDark={false} onClose={vi.fn()} onImported={onImported} />)

    fireEvent.click(screen.getByRole('button', { name: 'GitHub 仓库' }))
    fireEvent.change(screen.getByLabelText('GitHub 仓库地址'), {
      target: { value: candidate.source_url },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查配方' }))

    expect(await screen.findByRole('heading', { name: candidate.name })).toBeInTheDocument()
    expect(screen.getByText('94%')).toBeInTheDocument()
    expect(screen.getByText('包含可执行视觉规则')).toBeInTheDocument()
    expect(screen.getByText('原仓库未提供预览图，将使用配方默认封面。')).toBeInTheDocument()
    expect(screen.getByText('临时上传文件已清理')).toBeInTheDocument()

    const inspectCall = mocks.fetchWithAuth.mock.calls[0]
    expect(inspectCall[0]).toBe('/api/creative-styles/import/inspect')
    expect(inspectCall[1]).toMatchObject({ method: 'POST' })
    expect((inspectCall[1].body as FormData).get('github_url')).toBe(candidate.source_url)

    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({
      id: 'personal-cinema-1',
      name: candidate.name,
      isPersonal: true,
    })))
    expect(mocks.fetchWithAuth.mock.calls[1][0]).toBe('/api/creative-styles/import/confirm')
    expect(JSON.parse(String(mocks.fetchWithAuth.mock.calls[1][1].body))).toEqual({ review_token: 'review-token-1' })
    expect(await screen.findByText('灵感配方已导入')).toBeInTheDocument()
  })

  it('blocks confirmation when the bound review token is missing', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(response({
      accepted: true,
      candidate,
      review: { confidence: 0.9, checks: [], warnings: [] },
      cleanup: { temporary_upload_deleted: true },
    }))
    render(<CreativeSkillImportDialog open isDark={false} onClose={vi.fn()} onImported={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'GitHub 仓库' }))
    fireEvent.change(screen.getByLabelText('GitHub 仓库地址'), { target: { value: candidate.source_url } })
    fireEvent.click(screen.getByRole('button', { name: '检查配方' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('审核结果已失效，请重新检查配方')
    expect(screen.getByRole('button', { name: '确认导入' })).toBeDisabled()
    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1)
  })

  it('shows the product error when an archive has no image-generation style', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(response({ detail: '没有可用配方' }, 422))
    render(<CreativeSkillImportDialog open isDark onClose={vi.fn()} onImported={vi.fn()} />)

    const file = new File(['not-a-skill'], 'notes.zip', { type: 'application/zip' })
    fireEvent.change(screen.getByLabelText('选择 ZIP 配方包'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: '检查配方' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('未解析到生图相关的风格模板')
  })

  it('closes with Escape when no request is running', () => {
    const onClose = vi.fn()
    render(<CreativeSkillImportDialog open isDark={false} onClose={onClose} onImported={vi.fn()} />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
