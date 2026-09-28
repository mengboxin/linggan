<div align="center">

# 灵感 · Linggan

### 让一次生成，成为一套可持续推进的视觉作品

**Linggan 是开源的 AI 视觉创作与交付工作台。它把灵感、图像、编辑、画布、科研绘图和演示文稿放进同一个可追溯的创作系统。**

<p>
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a>
</p>

[![Live](https://img.shields.io/badge/体验产品-image.foxapi.cn-111111?style=for-the-badge&logo=googlechrome&logoColor=white)](https://image.foxapi.cn)
[![License](https://img.shields.io/badge/license-MIT-ff6b00?style=for-the-badge)](./LICENSE)
[![Frontend](https://img.shields.io/badge/React-19-61dafb?style=for-the-badge&logo=react&logoColor=111111)](#architecture)
[![Backend](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](#architecture)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-2ea44f?style=for-the-badge)](./CONTRIBUTING.md)

[立即体验](https://image.foxapi.cn) · [快速开始](#quick-start) · [产品能力](#capabilities) · [参与共建](#community)

</div>

<p align="center">
  <a href="https://image.foxapi.cn"><img src="./assets/readme/landing-hero.png" alt="Linggan 产品首页：把想象变成下一幅作品" width="100%" /></a>
</p>

<a id="why-linggan"></a>

## AI 让生成变快，Linggan 让创作不再断裂

做出一张图已经不难；真正困难的是把一次模糊的想法推进成完整、统一、可以交付的成果。参考图、提示词、不同轮次的结果、局部修改、分支方案和最终文件，往往散落在聊天窗口、硬盘和不同软件之间。每次修改都像重新开始。

Linggan 将“创作项目”而不是“单次提示词”作为工作单元：方向有来源，资产有上下文，编辑有分支，最终成果仍可预览、调整和导出。你始终知道一张图从哪里来、下一步可以去哪里。

> **输入一个想法，留下每一次有价值的选择，交付仍然可编辑的作品。**

<a id="workflow"></a>

## 一条从意图到交付的创作链路

| 01 · 定义方向 | 02 · 构建视觉 | 03 · 编排与迭代 | 04 · 完成表达 |
| --- | --- | --- | --- |
| 从一句描述、素材、参考图或已有作品开始，明确想传达什么。 | 生成图片、反推提示词、局部编辑，建立真正可用的视觉资产。 | 在画布上连接素材、参数、结果和分支，把探索过程变得可见。 | 组织为海报、科研图或 PPT，在交付前继续编辑、检查和导出。 |

<p align="center">
  <img src="./assets/readme/canvas-workflow.png" alt="Linggan 自由画布：将创作节点、素材和结果组织在同一空间" width="100%" />
</p>

<p align="center">
  <img src="./assets/readme/landing-product-experience.png" alt="Linggan 首页的产品体验导览：生成、编辑、画布、灵感广场与 PPT 创作" width="100%" />
</p>

<a id="use-cases"></a>

## 为需要“说清楚”的作品而设计

| 品牌与内容创作 | 创意探索与协作 | 科研视觉表达 | 汇报与演示交付 |
| --- | --- | --- | --- |
| 把视觉方向、参考素材和多轮生成沉淀成可继续制作的内容资产。 | 用画布保留思路、对比方案和关键节点，让讨论围绕作品本身发生。 | 将研究意图转为机制图、流程图、图形摘要和多面板科研图。 | 先确认叙事结构，再逐页生成、预览、修改并导出可编辑演示文稿。 |

Linggan 不是把多个生成入口简单堆在一起。它关心的是同一份视觉意图如何在不同产物之间延续：一张参考图可以成为提示词、生成任务、画布节点和 PPT 素材；一次修改也可以被保留为下一次决策的起点。

<a id="capabilities"></a>

## 关键体验

### 从生成结果，走向可复用资产

在统一工作台中配置模型、比例、尺寸、参考图和提示词，发起文生图或图生图。结果不会停留在一次性的对话附件里：它们可以进入编辑、画布、下一次生成或正式交付，并带着自己的创作来源继续流动。

<p align="center">
  <img src="./assets/readme/image-edit-workflow.png" alt="图片编辑工作流与可回溯分支" width="100%" />
</p>

### 让每一次修改都有来处

围绕导入图片、生成结果或已有素材，继续做局部重绘、擦除、替换、扩图、区域编辑和二次生成。Linggan 保留来源与分支关系，因此探索不同方向不意味着覆盖原来的判断。

<p align="center">
  <img src="./assets/readme/image-region-editing.png" alt="图片编辑中的区域标注、局部替换与图层工具" width="100%" />
</p>

### 把“看见喜欢的作品”变成“知道如何创作”

灵感广场承载作品、参数、标签和可迁移的创意配方；图生提示词则从主体、构图、镜头、光线、材质、色彩与排版安全区等维度拆解参考图。灵感不只被收藏，还能被理解、改写并带回新的项目。

<table>
  <tr>
    <td width="50%"><img src="./assets/readme/inspiration-gallery.png" alt="灵感广场与创意配方" /></td>
    <td width="50%"><img src="./assets/readme/prompt-reverse-engineering.png" alt="图生提示词与视觉拆解" /></td>
  </tr>
  <tr>
    <td align="center"><b>发现可复用的视觉方向</b><br />从作品、标签与配方中寻找下一步。</td>
    <td align="center"><b>把参考转为可编辑语言</b><br />理解画面，而不是机械复刻画面。</td>
  </tr>
</table>

<p align="center">
  <img src="./assets/readme/creative-recipes.png" alt="灵感配方：以构图、材质、色彩和输入要求锁定视觉方向" width="100%" />
</p>

### 在一个画布里看清复杂创作

自由画布把提示词、参考图、生成节点、结果预览和说明文字置于同一空间。连接输入与输出、保留分支、自动整理节点，令它成为真实的创作上下文，而不只是作品完成后的展示板。

<p align="center">
  <img src="./assets/readme/canvas-branch-workflow.png" alt="在自由画布中连接图片、提示词和多轮分支生成" width="100%" />
</p>

### 让正式交付保留控制权

对话式 PPT 先生成可调整的大纲，确认叙事之后再逐页推进；科研绘图支持机制示意、实验流程、图形摘要、论文多面板图和研究封面等表达。两条链路都把预览、编辑与导出留在最后一公里之前，而不是把不可控的初稿直接当成成品。

<table>
  <tr>
    <td width="50%"><img src="./assets/readme/ppt-outline.png" alt="PPT 大纲确认" /></td>
    <td width="50%"><img src="./assets/readme/ppt-presentation.png" alt="PPT 演示预览" /></td>
  </tr>
  <tr>
    <td align="center"><b>先定结构，再生产页面</b><br />把大纲作为可讨论、可修改的中间成果。</td>
    <td align="center"><b>让生成服务于叙事</b><br />逐页预览、编辑与导出，而非把文字塞进模板。</td>
  </tr>
  <tr>
    <td width="50%"><img src="./assets/readme/scientific-figure.png" alt="科研绘图生成" /></td>
    <td width="50%"><img src="./assets/readme/scientific-figure-editor.png" alt="科研绘图结果编辑" /></td>
  </tr>
  <tr>
    <td align="center"><b>把研究意图转为视觉初稿</b><br />覆盖图形摘要、机制图、实验流程与多面板图。</td>
    <td align="center"><b>在提交前继续打磨</b><br />调整、检查并导出 PNG 或 PDF。</td>
  </tr>
</table>

<a id="product-system"></a>

## 一个能承接长期创作的产品系统

| 层级 | Linggan 提供的能力 |
| --- | --- |
| **创作层** | 图片生成、图片编辑、图生提示词、自由画布、灵感探索、科研绘图与 PPT。 |
| **资产层** | 创作历史、素材复用、来源追踪、任务状态与可回溯的分支。 |
| **交付层** | 预览、修改、导出，以及适合正式沟通的图片、文档与演示成果。 |
| **运营层** | 用户、模型目录、任务与内容审核等运营管理能力。 |

模型能力通过适配层接入。部署后可按自己的模型服务、对象存储和业务约束组合创作链路；产品体验不会被某一个模型供应商定义。

### 将复杂工具变成可以自己走通的路径

内置学习中心把创作入口、历史与产物、算力与模型、账户与交付等核心操作拆成可跟随的任务路径。它让第一次使用的人理解整个系统如何连接，也让团队能以相同方式开始创作。

<p align="center">
  <img src="./assets/readme/learning-center.png" alt="Linggan 学习中心：从平台总览到完整创作链路的引导" width="100%" />
</p>

<a id="quick-start"></a>

## 快速开始

### 运行条件

- Node.js 20+
- Python 3.11+
- PostgreSQL 15+
- Redis 7+
- 可用的对象存储与兼容模型 API（按你的部署方案配置）

### 1. 启动 API 与任务执行器

```bash
git clone https://github.com/mengboxin/linggan.git
cd linggan

# macOS / Linux
cp backend/.env.example backend/.env

# Windows PowerShell
# Copy-Item backend/.env.example backend/.env

cd backend
pip install -r requirements.txt
```

在 `backend/.env` 填入数据库、Redis、管理员、模型服务与对象存储配置。为一个新数据库执行：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/init_db.sql
python scripts/run_migrate.py
```

启动 API 和本地开发 Worker：

```bash
# macOS / Linux
START_EMBEDDED_WORKER=true uvicorn main:app --reload --port 8000

# Windows PowerShell
# $env:START_EMBEDDED_WORKER = "true"
# uvicorn main:app --reload --port 8000
```

> 每个本地环境只运行一种 Worker 方式：使用 `START_EMBEDDED_WORKER=true`，或单独启动 `python worker_main.py`。

### 2. 启动用户端与管理端

```bash
# 终端 2：用户端，默认 http://127.0.0.1:5173
cd frontend
npm install
npm run dev

# 终端 3：管理后台，默认 http://127.0.0.1:5174
cd admin
npm install
npm run dev
```

<a id="architecture"></a>

## 架构

```text
┌──────────────────────────────────────────────────────────────┐
│ React + TypeScript + Vite                                     │
│ 用户端：创作 · 编辑 · 画布 · 灵感 · 科研绘图 · PPT             │
│ 管理端：用户 · 模型 · 任务 · 内容运营                          │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTP / WebSocket
┌────────────────────────────▼─────────────────────────────────┐
│ FastAPI                                                       │
│ 鉴权 · 资产 · 模型适配 · 任务编排 · 预览与交付                 │
└─────────────────┬────────────────────────────┬───────────────┘
                  │                            │
       ┌──────────▼──────────┐      ┌──────────▼──────────┐
       │ PostgreSQL + Redis  │      │ 异步 Worker          │
       │ 数据、会话与队列    │      │ 生成、渲染与导出     │
       └─────────────────────┘      └─────────────────────┘
                  │
       ┌──────────▼──────────┐
       │ 兼容模型 API / S3   │
       │ 图片、预览与交付物  │
       └─────────────────────┘
```

| 目录 | 说明 |
| --- | --- |
| `frontend/` | 用户端 React 应用：创作、编辑、画布、广场、PPT 与科研绘图。 |
| `admin/` | 运营管理后台。 |
| `backend/` | FastAPI API、鉴权、资产、模型适配、异步任务与业务逻辑。 |
| `backend/migrations/` | 数据库迁移。 |
| `backend/scripts/` | 初始化、迁移与维护脚本。 |

<a id="community"></a>

## 一起把它做得更好

Linggan 最需要的不是泛泛的点赞，而是来自真实创作场景的判断。无论你是设计师、研究者、内容团队，还是在搭建自己的 AI 创作工具，都欢迎参与。

- [报告问题](https://github.com/mengboxin/linggan/issues/new/choose)：请附复现步骤、期望结果和必要截图。
- [提出功能想法](https://github.com/mengboxin/linggan/issues/new/choose)：特别欢迎描述你的工作流、卡点和理想交付物。
- [提交代码](./CONTRIBUTING.md)：从一个聚焦的修复、交互细节、模型适配或文档改进开始。

### 加入交流

扫码加入 **灵感 AI 创作平台交流群**，或搜索 QQ 群号：**432142734**。

<p align="center">
  <img src="./assets/readme/community-qq-group.png" alt="灵感 AI 创作平台交流群二维码，QQ群号 432142734" width="320" />
</p>

提交前可运行：

```bash
npm --prefix frontend run lint
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix admin run build
```

## 开源协议

本项目采用 [MIT License](./LICENSE)。第三方组件、模型服务与创作素材应遵循各自的许可证和服务条款。
