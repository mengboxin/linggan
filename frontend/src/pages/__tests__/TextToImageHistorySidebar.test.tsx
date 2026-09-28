import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { GenCard } from '../../components/GenerativeCanvas/GenerativeCanvas'
import { PreviewPanel } from '../../components/PreviewPanel/PreviewPanel'
import {
  cacheableRemoteImageCard,
  shouldResolveImageHistoryCard,
  shouldShowTextToImageComposer,
  TextToImageHistorySidebar,
} from '../EditorPage'

vi.mock('../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

vi.mock('../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
  resolveAppearanceTokens: () => ({
    accent: '#171717',
    accentSoft: 'rgba(17,17,17,0.08)',
    panelSoft: 'rgba(250,250,249,0.82)',
    border: 'rgba(17,17,17,0.1)',
    borderStrong: 'rgba(17,17,17,0.2)',
    text: '#171717',
    dot: 'rgba(17,17,17,0.25)',
  }),
}))

describe('TextToImageHistorySidebar', () => {
  it('shows a newly submitted image card as loading instead of failed', () => {
    const loadingCard: GenCard = {
      id: 'gen-task-1',
      taskId: 'task-1',
      imageBase64: '',
      prompt: 'test prompt',
      createdAt: Date.now(),
      x: 0,
      y: 0,
      hasImage: false,
      imageLoading: true,
    }

    render(
      <TextToImageHistorySidebar
        lang="zh"
        theme="light"
        mergedImageHistoryCards={[loadingCard]}
        taskItems={[]}
        remoteImageHistoryLoading={false}
        imageHistoryLoadingId={null}
        selectedCard={loadingCard}
        onPreview={vi.fn()}
        onEdit={vi.fn()}
        onPublish={vi.fn()}
        onDeleteCard={vi.fn()}
        onClearTask={vi.fn()}
        onNew={vi.fn()}
      />,
    )

    expect(screen.getByText('生成中')).toBeInTheDocument()
    expect(screen.getByText('0 张图片 · 0 条失败 · 1 个任务')).toBeInTheDocument()
    expect(screen.queryByText('生成失败，请调整提示词后重试。')).not.toBeInTheDocument()
  })

  it('keeps image-edit import available while public submissions are disabled', () => {
    const completedCard: GenCard = {
      id: 'history-image-1',
      imageBase64: '/api/assets/image-1/original',
      prompt: 'completed prompt',
      createdAt: Date.now(),
      x: 0,
      y: 0,
      hasImage: true,
    }

    render(
      <TextToImageHistorySidebar
        lang="zh"
        theme="light"
        mergedImageHistoryCards={[completedCard]}
        taskItems={[]}
        remoteImageHistoryLoading={false}
        imageHistoryLoadingId={null}
        selectedCard={completedCard}
        onPreview={vi.fn()}
        onEdit={vi.fn()}
        onPublish={vi.fn()}
        onDeleteCard={vi.fn()}
        onClearTask={vi.fn()}
        onNew={vi.fn()}
      />,
    )

    expect(screen.getByTitle('导入工作流编辑')).toBeInTheDocument()
    expect(screen.queryByTitle('申请公开到灵感广场')).not.toBeInTheDocument()
  })

  it('stores stable API asset references instead of expiring signed delivery URLs', () => {
    const cached = cacheableRemoteImageCard({
      id: 'history-image-1',
      assetId: 'asset-1',
      imageBase64: 'https://image.example.test/assets/original.png?expires=1&signature=stale',
      thumbnailBase64: 'https://image.example.test/assets/thumb.webp?expires=1&signature=stale',
      imageUrl: 'https://image.example.test/assets/original.png?expires=1&signature=stale',
      previewUrl: 'https://image.example.test/assets/preview.webp?expires=1&signature=stale',
      thumbnailUrl: 'https://image.example.test/assets/thumb.webp?expires=1&signature=stale',
      prompt: 'history image',
      createdAt: Date.now(),
      x: 0,
      y: 0,
      hasImage: true,
    })

    expect(cached.imageBase64).toBe('/api/assets/asset-1/original')
    expect(cached.thumbnailBase64).toBe('/api/assets/asset-1/thumb')
    expect(cached.imageUrl).toBe('/api/assets/asset-1/original')
    expect(cached.previewUrl).toBe('/api/assets/asset-1/preview')
    expect(cached.thumbnailUrl).toBe('/api/assets/asset-1/thumb')
    expect(JSON.stringify(cached)).not.toContain('signature=stale')
  })

  it('does not resolve an in-flight task as a historical image', () => {
    expect(shouldResolveImageHistoryCard({
      taskId: 'task-1',
      imageLoading: true,
      hasImage: false,
      status: undefined,
    })).toBe(false)

    expect(shouldResolveImageHistoryCard({
      conversationId: 'conversation-1',
      hasImage: true,
      imageLoading: false,
    })).toBe(true)
  })

  it('keeps the workspace preview in generation state before a result exists', () => {
    const loadingCard: GenCard = {
      id: 'gen-task-1',
      taskId: 'task-1',
      imageBase64: '',
      prompt: 'test prompt',
      createdAt: Date.now(),
      x: 0,
      y: 0,
      hasImage: false,
      imageLoading: true,
    }

    render(
      <PreviewPanel
        card={loadingCard}
        onZoom={vi.fn()}
        onDownload={vi.fn()}
        onEdit={vi.fn()}
      />,
    )

    expect(screen.getByText('正在生成图片...')).toBeInTheDocument()
    expect(screen.queryByText('正在加载图片...')).not.toBeInTheDocument()
    expect(screen.queryByText('加载失败')).not.toBeInTheDocument()
  })

  it('only shows the text-to-image composer before a generation or history result is selected', () => {
    const selectedCard: GenCard = {
      id: 'missing-history-image',
      imageBase64: 'https://image.example.test/missing-history-image.webp',
      prompt: 'missing image prompt',
      createdAt: Date.now(),
      x: 0,
      y: 0,
      hasImage: true,
    }

    expect(shouldShowTextToImageComposer('TEXT_TO_IMAGE', null)).toBe(true)
    expect(shouldShowTextToImageComposer('TEXT_TO_IMAGE', selectedCard)).toBe(false)
    expect(shouldShowTextToImageComposer('TEXT_TO_IMAGE', { ...selectedCard, imageLoading: true })).toBe(false)
    expect(shouldShowTextToImageComposer('IMAGE_EDIT', null)).toBe(false)
  })
})
