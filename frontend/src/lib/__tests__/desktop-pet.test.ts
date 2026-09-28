import { describe, expect, it, vi } from 'vitest'

import {
  desktopPetAppearance,
  desktopPetStateForRoute,
  syncDesktopPetAppearance,
  syncDesktopPetMode,
  syncDesktopPetTasks,
} from '../desktop-pet'
import { DEFAULT_APPEARANCE } from '../theme'
import { projectDesktopPetTaskSnapshot } from '../task-pet-projection'

describe('desktop pet route feedback', () => {
  it.each([
    ['/text-to-image', 'mode_image'],
    ['/image-edit', 'mode_layer'],
    ['/ppt', 'mode_ppt'],
    ['/presentations', 'mode_presentation'],
    ['/scientific-figure', 'mode_scifig'],
    ['/poster', 'mode_poster'],
    ['/paper-lab', 'mode_paper'],
    ['/image-to-prompt', 'mode_prompt'],
    ['/gallery', 'mode_gallery'],
    ['/canvas-flow', 'mode_canvas'],
    ['/profile', 'mode_profile'],
    ['/recharge', 'mode_billing'],
    ['/models', 'mode_models'],
  ])('maps %s to %s', (pathname, expected) => {
    expect(desktopPetStateForRoute(pathname, 'IMAGE_EDIT')).toBe(expected)
  })

  it('falls back to the live editor mode on the legacy editor route', () => {
    expect(desktopPetStateForRoute('/editor', 'POSTER_GEN')).toBe('mode_poster')
  })

  it('passes resolved surface and accent colors to the pet window', () => {
    const appearance = desktopPetAppearance(DEFAULT_APPEARANCE)

    expect(appearance).toMatchObject({
      theme: 'light',
      appearance: {
        surface: expect.any(String),
        panel: expect.any(String),
        control: expect.any(String),
        controlHover: expect.any(String),
        text: expect.any(String),
        muted: expect.any(String),
        border: expect.any(String),
        primary: expect.any(String),
        primaryHover: expect.any(String),
        primarySoft: expect.any(String),
        onPrimary: expect.any(String),
      },
    })
  })

  it('sends the current route state even when the pet window is hidden', () => {
    const api = {
      petSetTheme: vi.fn().mockResolvedValue({ ok: true }),
      petSetState: vi.fn().mockResolvedValue({ ok: true }),
    }

    syncDesktopPetAppearance(api, DEFAULT_APPEARANCE)
    syncDesktopPetMode(api, desktopPetStateForRoute('/canvas-flow', 'IMAGE_EDIT'), 'token')

    expect(api.petSetTheme).toHaveBeenCalledWith(desktopPetAppearance(DEFAULT_APPEARANCE))
    expect(api.petSetState).toHaveBeenCalledWith({ state: 'mode_canvas', token: 'token' })
  })

  it('does not invent an editor reaction for login and legal routes', () => {
    expect(desktopPetStateForRoute('/login', 'IMAGE_EDIT')).toBeNull()
    expect(desktopPetStateForRoute('/privacy', 'TEXT_TO_IMAGE')).toBeNull()
  })

  it('sends the complete live and recent terminal task snapshot', () => {
    const api = {
      petSyncTasks: vi.fn().mockResolvedValue({ ok: true }),
    }
    const snapshot = projectDesktopPetTaskSnapshot([
      {
        id: 'ppt-1', taskType: 'ppt_generation', status: 'running', title: 'Deck',
        progress: 42, stageLabel: '制作页面', stageDetail: '正在制作第 3 页',
        startedAt: 100, updatedAt: 300, targetPath: '/ppt',
      },
      {
        id: 'image-1', taskType: 'image_generation', status: 'success', title: 'Image',
        progress: 100, startedAt: 50, updatedAt: 200, completedAt: 200,
      },
    ], { modeState: 'mode_ppt', currentPath: '/ppt', token: 'token', now: 500 })

    syncDesktopPetTasks(api, snapshot)

    expect(snapshot).toMatchObject({
      state: 'task_snapshot',
      activeTaskId: 'ppt-1',
      activeCount: 1,
      modeState: 'mode_ppt',
      tasks: [
        expect.objectContaining({ id: 'ppt-1', moduleLabel: 'PPT 生成', stageLabel: '制作页面' }),
        expect.objectContaining({ id: 'image-1', status: 'success' }),
      ],
    })
    expect(api.petSyncTasks).toHaveBeenCalledWith(snapshot)
  })
})
