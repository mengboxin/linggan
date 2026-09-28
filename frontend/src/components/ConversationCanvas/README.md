# ConversationCanvas 使用指南

## 快速开始

### 1. 导入组件

```tsx
import { ConversationCanvas } from '../components/ConversationCanvas/ConversationCanvas'
import { WorkspaceConversation } from '../components/WorkspaceDrawer/WorkspaceDrawer'
```

### 2. 添加状态管理

```tsx
const [showImageCanvas, setShowImageCanvas] = useState(false)
const [showLayerCanvas, setShowLayerCanvas] = useState(false)
const [currentConversation, setCurrentConversation] = useState<WorkspaceConversation | null>(null)
```

### 3. 处理对话打开

```tsx
<WorkspaceDrawer
  // ... 其他属性
  onOpenConversation={(conv) => {
    setCurrentConversation(conv)
    if (conv.type === 'image') {
      setShowImageCanvas(true)
    }
    // PPT 类型的对话在 PPT 面板中处理
  }}
/>
```

### 4. 渲染画布

```tsx
{showImageCanvas && (
  <ConversationCanvas
    conversationType="image"
    onClose={() => {
      setShowImageCanvas(false)
      setCurrentConversation(null)
    }}
  />
)}

{showLayerCanvas && (
  <ConversationCanvas
    conversationType="layer-edit"
    onClose={() => {
      setShowLayerCanvas(false)
      setCurrentConversation(null)
    }}
  />
)}
```

## 完整示例

```tsx
import React, { useState } from 'react'
import { ConversationCanvas } from './components/ConversationCanvas/ConversationCanvas'
import { WorkspaceDrawer, WorkspaceConversation } from './components/WorkspaceDrawer/WorkspaceDrawer'

export function EditorPage() {
  const [showImageCanvas, setShowImageCanvas] = useState(false)
  const [showLayerCanvas, setShowLayerCanvas] = useState(false)
  const [currentConversation, setCurrentConversation] = useState<WorkspaceConversation | null>(null)

  const handleOpenConversation = (conv: WorkspaceConversation) => {
    setCurrentConversation(conv)
    
    switch (conv.type) {
      case 'image':
        setShowImageCanvas(true)
        break
      case 'ppt':
        // PPT 对话在 PPT 面板中处理
        break
    }
  }

  const handleCloseCanvas = () => {
    setShowImageCanvas(false)
    setShowLayerCanvas(false)
    setCurrentConversation(null)
  }

  return (
    <div className="relative w-full h-screen">
      {/* 主编辑器界面 */}
      <div className="flex h-full">
        {/* 左侧工作区 */}
        <WorkspaceDrawer
          currentTaskId={null}
          onLoadTask={() => {}}
          onNewTask={() => {}}
          onOpenConversation={handleOpenConversation}
        />

        {/* 中间画布区域 */}
        <div className="flex-1">
          {/* 你的编辑器内容 */}
        </div>
      </div>

      {/* 对话画布覆盖层 */}
      {showImageCanvas && (
        <ConversationCanvas
          conversationType="image"
          onClose={handleCloseCanvas}
        />
      )}

      {showLayerCanvas && (
        <ConversationCanvas
          conversationType="layer-edit"
          onClose={handleCloseCanvas}
        />
      )}
    </div>
  )
}
```

## 功能特性

### 画布操作

- **拖动**: 鼠标左键按住画布空白处拖动
- **缩放**: 滚轮上下滚动缩放（10% - 300%）
- **重置**: 点击顶部缩放控制器的 + / - 按钮

### 对话操作

- **发送消息**: 输入内容后点击"生成"按钮，或按 Ctrl+Enter
- **查看历史**: 点击左侧栏的对话项查看历史消息
- **新建对话**: 点击"新建对话"按钮开始新的对话
- **删除对话**: 悬停在对话项上，点击删除按钮

### 键盘快捷键

- `Ctrl + Enter` / `Cmd + Enter`: 发送消息
- `Esc`: 关闭画布（需要自己实现）

## 自定义样式

组件使用 Tailwind CSS 和内联样式，支持暗色/亮色主题自动切换。

如需自定义样式，可以修改组件内的样式对象：

```tsx
// 修改画布背景
style={{
  background: isDark 
    ? 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 0)'
    : 'radial-gradient(circle at 1px 1px, rgba(0,0,0,0.05) 1px, transparent 0)',
  backgroundSize: '40px 40px',
}}
```

## API 集成

### 发送消息

在 `handleSendMessage` 函数中集成你的 API：

```tsx
const handleSendMessage = async () => {
  if (!inputText.trim() || isGenerating) return

  setIsGenerating(true)
  try {
    // 1. 创建或获取对话
    let conversationId = currentConversation?.id
    if (!conversationId) {
      const res = await auth.fetchWithAuth(apiUrl('/api/conversations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: conversationType,
          title: inputText.slice(0, 20), // 临时标题，后端会用 AI 优化
        }),
      })
      const conv = await res.json()
      conversationId = conv.id
    }

    // 2. 保存用户消息
    await auth.fetchWithAuth(apiUrl(`/api/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'user',
        content: inputText,
      }),
    })

    // 3. 调用生成 API
    const genRes = await auth.fetchWithAuth(apiUrl('/api/generate/image'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: inputText,
        conversation_id: conversationId,
      }),
    })
    const genData = await genRes.json()

    // 4. 保存 AI 响应
    await auth.fetchWithAuth(apiUrl(`/api/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'assistant',
        content: '图像已生成',
        meta: {
          image_url: genData.image_url,
          task_id: genData.task_id,
        },
      }),
    })

    // 5. 刷新消息列表
    await loadMessages(conversationId)
    
    setInputText('')
  } catch (error) {
    console.error('生成失败:', error)
    alert('生成失败，请重试')
  } finally {
    setIsGenerating(false)
  }
}
```

## 注意事项

1. **性能优化**: 大量图像时考虑使用虚拟滚动
2. **错误处理**: 添加适当的错误提示和重试机制
3. **加载状态**: 显示生成进度和加载动画
4. **响应式**: 确保在不同屏幕尺寸下都能正常使用
5. **无障碍**: 添加适当的 ARIA 标签和键盘导航支持

## 常见问题

### Q: 如何加载现有对话？

A: 在打开画布时传入对话 ID，然后调用 `loadMessages` 函数：

```tsx
useEffect(() => {
  if (currentConversation) {
    loadMessages(currentConversation.id)
  }
}, [currentConversation])
```

### Q: 如何自定义画布项的布局？

A: 修改 `loadMessages` 函数中的布局逻辑：

```tsx
// 网格布局
items.push({
  x: 100 + (index % 3) * 400,
  y: Math.floor(index / 3) * 400 + 100,
  // ...
})

// 瀑布流布局
// 自己实现瀑布流算法
```

### Q: 如何添加更多画布项类型？

A: 扩展 `CanvasItem` 接口和渲染逻辑：

```tsx
interface CanvasItem {
  type: 'image' | 'text' | 'video' | 'audio'
  // ...
}

// 在渲染时添加新类型的处理
{item.type === 'video' && (
  <video src={item.content} controls />
)}
```

## 更多资源

- [架构设计文档](../../CONVERSATION_CANVAS_ARCHITECTURE.md)
- [API 文档](../../backend/README.md)
- [Stitch 设计参考](https://stitch.ai)
