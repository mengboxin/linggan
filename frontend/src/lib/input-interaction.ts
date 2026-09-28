import type { DOMAttributes, SyntheticEvent } from 'react'

export function stopInputInteraction(event: SyntheticEvent) {
  event.stopPropagation()
}

export const inputInteractionProps: Pick<
  DOMAttributes<HTMLElement>,
  | 'onPointerDownCapture'
  | 'onPointerUpCapture'
  | 'onMouseDownCapture'
  | 'onMouseUpCapture'
  | 'onClickCapture'
  | 'onDoubleClickCapture'
> = {
  onPointerDownCapture: stopInputInteraction,
  onPointerUpCapture: stopInputInteraction,
  onMouseDownCapture: stopInputInteraction,
  onMouseUpCapture: stopInputInteraction,
  onClickCapture: stopInputInteraction,
  onDoubleClickCapture: stopInputInteraction,
}
