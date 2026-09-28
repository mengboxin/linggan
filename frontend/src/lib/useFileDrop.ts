import { useCallback, useState, type DragEvent } from 'react'

interface UseFileDropOptions {
  disabled?: boolean
  onFiles: (files: File[]) => void | Promise<void>
}

export function useFileDrop({ disabled = false, onFiles }: UseFileDropOptions) {
  const [isDragging, setIsDragging] = useState(false)

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (disabled) return
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(true)
  }, [disabled])

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (disabled) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragging(false)
    }
  }, [disabled])

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (disabled) return
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)
    const files = Array.from(event.dataTransfer.files || [])
    if (files.length) void onFiles(files)
  }, [disabled, onFiles])

  return {
    isDragging,
    dropProps: {
      onDragOver,
      onDragLeave,
      onDrop,
    },
  }
}
