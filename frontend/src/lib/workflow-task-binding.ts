export function shouldDiscardCreatedWorkflowTask(input: {
  requestedBindingEpoch: number
  currentBindingEpoch: number
  currentTaskId: string | null | undefined
  createdTaskId: string
}) {
  return input.currentBindingEpoch !== input.requestedBindingEpoch
    && input.currentTaskId !== input.createdTaskId
}

export function workflowBindingCreationKey(currentKey: string | null, createKey: () => string) {
  return currentKey || createKey()
}
