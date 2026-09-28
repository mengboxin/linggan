import { useTaskToastStore, TASK_MESSAGES, TASK_ICONS, type TaskType } from './task-toast-store'
import { useEditorStore } from './editor-store'

function getNavigationForTask(taskType: TaskType) {
  const { setMode } = useEditorStore.getState()
  switch (taskType) {
    case 'image_generation':
    case 'layer_edit':
    case 'segmentation':
      setMode('IMAGE_EDIT')
      break
    case 'ppt_generation':
      setMode('PPT_GEN')
      break
    case 'poster_generation':
      setMode('POSTER_GEN')
      break
    case 'sci_fig_generation':
      setMode('SCI_FIG')
      break
  }
}

export function useTaskToast() {
  const show = useTaskToastStore((s) => s.show)
  const dismiss = useTaskToastStore((s) => s.dismiss)
  const toasts = useTaskToastStore((s) => s.toasts)

  const notify = (taskType: TaskType) => {
    show({
      taskType,
      message: TASK_MESSAGES[taskType],
      icon: TASK_ICONS[taskType],
      onClick: () => getNavigationForTask(taskType),
    })
  }

  return { notify, dismiss, toasts }
}
