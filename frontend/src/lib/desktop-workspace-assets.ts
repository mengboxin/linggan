import { auth } from './auth'
import { getElectronAPI, isElectron } from './electron'
import { imageSrc, isRemoteLikeImage } from './image-url'
import { isDesktopLocalWorkspace } from './storage-workspace'

function filenameSafe(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 72) || 'generated-image'
}

export async function persistDesktopWorkspaceImage(
  source: string,
  options: { category: string; filename: string },
) {
  if (!source || !isElectron() || !isDesktopLocalWorkspace()) return null
  const api = getElectronAPI()
  const filename = `${filenameSafe(options.filename)}.png`
  const subdir = filenameSafe(options.category)
  const userId = auth.getUser()?.id || 'anonymous'
  try {
    if (isRemoteLikeImage(source)) {
      const result = await api?.saveRemoteImageLocal?.({
        url: imageSrc(source),
        filename,
        subdir,
        userId,
        token: auth.getAccessToken(),
      })
      return result?.ok ? result : null
    }
    const result = await api?.saveImageLocal({
      base64: source,
      filename,
      subdir,
      workspaceLocal: true,
      userId,
    })
    return result?.ok ? result : null
  } catch {
    return null
  }
}
