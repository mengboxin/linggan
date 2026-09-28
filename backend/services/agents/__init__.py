"""
Agent 编排服务

@ported-from https://github.com/11cafe/jaaz
@original-license MIT
@modifications
  - R7.3: 替换 socket.io/websocket 为 Redis pubsub SSE
  - 剔除 jaaz 专属工具（Imagen/Veo），保留节点编辑器与状态机
  - 改造为 PixelScribe 工具集（Inpainting/OCR/TextRender/PPT）
  - 添加 plan_node 分解指令为 SubTask[]
  - 添加 execute_plan 主循环 + retry/skip/abort
  - 添加 batch variants 并行执行

Requirements: R7.1, R7.2, R7.3, R7.4, R7.5, R7.6
"""

from .prompt_agent import PromptAgent
from .layer_edit_agent import LayerEditAgent

__all__ = ["LayerEditAgent", "PromptAgent"]
