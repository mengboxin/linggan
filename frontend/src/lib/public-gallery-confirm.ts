export interface PublicGalleryConfirmOptions {
  title: string
  message: string
  confirmText: string
  cancelText: string
}

export function publicGallerySubmitConfirmOptions(lang: 'zh' | 'en' | string = 'zh'): PublicGalleryConfirmOptions {
  if (lang === 'en') {
    return {
      title: 'Submit to Gallery',
      message: 'Submit this work for gallery review? It will only be shown publicly after admin approval, and credits are rewarded by the admin rule.',
      confirmText: 'Submit',
      cancelText: 'Cancel',
    }
  }
  return {
    title: '公开到灵感广场',
    message: '确认将这个作品提交到灵感广场审核吗？审核通过后才会公开展示，并按后台规则奖励平台生图积分。',
    confirmText: '提交审核',
    cancelText: '取消',
  }
}
