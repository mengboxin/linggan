/**
 * Linggan Sync 面板 UI（原生 DOM 实现）
 */
const wsClient = require('../ws/client');
const idMap = require('../utils/id-map');
const changeDetector = require('../ps/events');
const { createDocument } = require('../ps/document');
const { importLayerFromBase64, updateLayerProperties, reorderLayers, deleteLayer } = require('../ps/layers');
const { app } = require('photoshop');

const STATUS_TEXT = {
  disconnected: '未连接',
  connecting: '连接中...',
  connected: '已连接',
  syncing: '同步中...'
};

const STATUS_COLORS = {
  disconnected: '#888',
  connecting: '#ffaa00',
  connected: '#44cc44',
  syncing: '#4488ff'
};

// 面板状态
const state = {
  status: 'disconnected',
  port: 9527,
  projectName: '',
  syncedLayers: [],
  errorMessage: '',
  rootEl: null,
  unsubStatus: null,
  unsubMessage: null
};

/**
 * 渲染面板 UI
 * @param {HTMLElement} root - 根元素
 */
function renderPanel(root) {
  state.rootEl = root;
  root.innerHTML = '';

  const container = document.createElement('div');
  container.style.cssText = 'padding:12px;display:flex;flex-direction:column;height:100%;gap:10px;';

  // ─── 顶部状态栏 ─────────────────────────────────────────
  const statusBar = document.createElement('div');
  statusBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:#2a2a2a;border-radius:4px;';
  statusBar.innerHTML = `
    <div id="status-dot" style="width:8px;height:8px;border-radius:50%;background:${STATUS_COLORS[state.status]};"></div>
    <span id="status-text" style="font-weight:bold;">${STATUS_TEXT[state.status]}</span>
    <span id="project-name" style="color:#aaa;font-size:11px;"></span>
  `;
  container.appendChild(statusBar);

  // ─── 连接区 ────────────────────────────────────────────
  const connectSection = document.createElement('div');
  connectSection.id = 'connect-section';
  container.appendChild(connectSection);

  // ─── 错误提示 ────────────────────────────────────────────
  const errorBox = document.createElement('div');
  errorBox.id = 'error-box';
  errorBox.style.cssText = 'display:none;padding:8px;background:#3d1f1f;border:1px solid #ff4444;border-radius:4px;color:#ff8888;font-size:11px;';
  container.appendChild(errorBox);

  // ─── 图层列表 ────────────────────────────────────────────
  const layerSection = document.createElement('div');
  layerSection.id = 'layer-section';
  layerSection.style.cssText = 'flex:1;overflow-y:auto;';
  container.appendChild(layerSection);

  root.appendChild(container);

  updateConnectSection();
  updateLayerSection();
  subscribeWsEvents();
}

/**
 * 更新连接区
 */
function updateConnectSection() {
  const section = document.getElementById('connect-section');
  if (!section) return;
  section.innerHTML = '';

  if (state.status === 'disconnected') {
    // 未连接：显示连接按钮（端口隐藏，使用默认值）
    const btn = document.createElement('button');
    btn.textContent = '连接到 PixelScribe';
    btn.style.cssText = 'width:100%;padding:10px;background:#0d6efd;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
    btn.onclick = handleConnect;
    section.appendChild(btn);

    // 高级：端口配置（折叠）
    const details = document.createElement('details');
    details.style.cssText = 'margin-top:8px;';
    details.innerHTML = `
      <summary style="cursor:pointer;color:#888;font-size:11px;">高级设置</summary>
      <div style="display:flex;gap:6px;align-items:center;margin-top:6px;">
        <label style="font-size:11px;color:#ccc;">端口：</label>
        <input id="port-input" type="number" value="${state.port}" min="1" max="65535"
               style="flex:1;padding:4px 6px;background:#1a1a1a;border:1px solid #444;color:#e0e0e0;border-radius:3px;font-size:12px;">
      </div>
    `;
    section.appendChild(details);
  } else {
    // 已连接：显示断开按钮
    const btn = document.createElement('button');
    btn.textContent = '断开连接';
    btn.style.cssText = 'width:100%;padding:8px;background:#dc3545;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
    btn.onclick = handleDisconnect;
    section.appendChild(btn);
  }
}

/**
 * 更新图层列表区
 */
function updateLayerSection() {
  const section = document.getElementById('layer-section');
  if (!section) return;
  section.innerHTML = '';

  if (state.syncedLayers.length === 0) {
    if (state.status !== 'disconnected') {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;color:#666;font-size:12px;font-style:italic;padding:20px;';
      empty.textContent = '等待图层推送...';
      section.appendChild(empty);
    }
    return;
  }

  const title = document.createElement('div');
  title.style.cssText = 'font-size:11px;color:#aaa;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
  title.textContent = `已同步图层 (${state.syncedLayers.length})`;
  section.appendChild(title);

  state.syncedLayers.forEach((layer) => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;background:#2a2a2a;border-radius:3px;margin-bottom:4px;';
    item.innerHTML = `
      <div style="width:24px;height:24px;background:#444;border-radius:2px;flex-shrink:0;"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(layer.name)}</div>
        <div style="font-size:10px;color:#888;margin-top:2px;">最后同步: ${layer.lastSync}</div>
      </div>
    `;
    section.appendChild(item);
  });
}

/**
 * 更新状态栏
 */
function updateStatusBar() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const project = document.getElementById('project-name');
  if (dot) dot.style.background = STATUS_COLORS[state.status];
  if (text) text.textContent = STATUS_TEXT[state.status];
  if (project) project.textContent = state.projectName ? `| ${state.projectName}` : '';
}

/**
 * 显示错误
 */
function showError(msg) {
  state.errorMessage = msg;
  const box = document.getElementById('error-box');
  if (box) {
    if (msg) {
      box.style.display = 'block';
      box.textContent = msg;
    } else {
      box.style.display = 'none';
    }
  }
}

/**
 * 订阅 WebSocket 事件
 */
function subscribeWsEvents() {
  if (state.unsubStatus) state.unsubStatus();
  if (state.unsubMessage) state.unsubMessage();

  state.unsubStatus = wsClient.onStatusChange((newStatus) => {
    state.status = newStatus;
    if (newStatus === 'disconnected') {
      state.projectName = '';
      state.syncedLayers = [];
    }
    updateStatusBar();
    updateConnectSection();
    updateLayerSection();
  });

  state.unsubMessage = wsClient.onMessage((msg) => {
    handleIncomingMessage(msg);
  });
}

/**
 * 处理收到的消息
 */
async function handleIncomingMessage(msg) {
  try {
    switch (msg.type) {
      case 'push-layers':
        await handlePushLayers(msg.payload);
        break;
      case 'sync-complete':
        handleSyncComplete(msg.payload);
        break;
      case 'property-changed':
        await handleUpdateProperty(msg.payload);
        break;
      case 'order-changed':
        await handleUpdateOrder(msg.payload);
        break;
      case 'layer-added':
        await handleAddLayer(msg.payload);
        break;
      case 'layer-deleted':
        await handleDeleteLayer(msg.payload);
        break;
      case 'error':
        showError(msg.payload.message || '发生未知错误');
        break;
    }
  } catch (err) {
    showError(`处理消息失败: ${err.message}`);
  }
}

/**
 * 处理推送图层
 */
async function handlePushLayers(payload) {
  state.status = 'syncing';
  updateStatusBar();
  showError('');

  try {
    const { layers, projectName, canvasWidth, canvasHeight } = payload;
    state.projectName = projectName || '';
    updateStatusBar();

    changeDetector.pause();

    const mappings = await createDocument(layers, projectName, canvasWidth, canvasHeight);
    const validMappings = mappings.filter((m) => m.psLayerId > 0);
    idMap.initFromSyncComplete(validMappings);

    const snapshotLayers = validMappings.map((m) => {
      const layerData = layers.find((l) => l.platformId === m.platformId);
      return {
        psLayerId: m.psLayerId,
        name: layerData?.name || '',
        visible: layerData?.visible !== false,
        opacity: layerData?.opacity ?? 1
      };
    });
    await changeDetector.initSnapshots(snapshotLayers);
    changeDetector.start(
      (message) => wsClient.send(message),
      (psLayerId) => idMap.getPlatformId(psLayerId)
    );
    changeDetector.resume();

    const now = new Date().toLocaleTimeString();
    state.syncedLayers = validMappings.map((m) => {
      const layerData = layers.find((l) => l.platformId === m.platformId);
      return {
        platformId: m.platformId,
        psLayerId: m.psLayerId,
        name: layerData?.name || '未命名',
        lastSync: now
      };
    });

    wsClient.send({
      type: 'sync-complete',
      payload: {
        mappings: validMappings,
        failedLayers: mappings.filter((m) => m.psLayerId <= 0).map((m) => m.platformId)
      },
      timestamp: new Date().toISOString(),
      messageId: generateId()
    });

    state.status = 'connected';
  } catch (err) {
    showError(`推送失败: ${err.message}`);
    state.status = 'connected';
    changeDetector.resume();
  }
  updateStatusBar();
  updateLayerSection();
}

function handleSyncComplete(payload) {
  if (payload.mappings) {
    idMap.initFromSyncComplete(payload.mappings);
  }
}

async function handleUpdateProperty(payload) {
  const { platformId, changes } = payload;
  const psLayerId = idMap.getPsLayerId(platformId);
  if (!psLayerId) return;

  changeDetector.pause();
  try {
    await updateLayerProperties(psLayerId, changes);
    changeDetector.updateSnapshot(psLayerId, changes);
  } catch (err) {
    showError(`属性更新失败: ${err.message}`);
  }
  changeDetector.resume();
}

async function handleUpdateOrder(payload) {
  const { orderedIds } = payload;
  const orderedPsIds = orderedIds
    .map((pid) => idMap.getPsLayerId(pid))
    .filter((id) => id !== null);
  if (orderedPsIds.length === 0) return;

  changeDetector.pause();
  try {
    await reorderLayers(orderedPsIds);
  } catch (err) {
    showError(`顺序调整失败: ${err.message}`);
  }
  changeDetector.resume();
}

async function handleAddLayer(payload) {
  const { platformId, name, imageBase64, position } = payload;

  changeDetector.pause();
  try {
    const psLayerId = await importLayerFromBase64(imageBase64, name, position);
    if (psLayerId > 0) {
      idMap.setMapping(platformId, psLayerId);
      changeDetector.addSnapshot(psLayerId, {
        name, visible: true, opacity: 1, contentHash: `new_${Date.now()}`
      }, position);
      const now = new Date().toLocaleTimeString();
      state.syncedLayers.push({ platformId, psLayerId, name, lastSync: now });
      updateLayerSection();
    }
  } catch (err) {
    showError(`新增图层失败: ${err.message}`);
  }
  changeDetector.resume();
}

async function handleDeleteLayer(payload) {
  const { platformId } = payload;
  const psLayerId = idMap.getPsLayerId(platformId);
  if (!psLayerId) return;

  changeDetector.pause();
  try {
    await deleteLayer(psLayerId);
    idMap.removeMapping(platformId);
    changeDetector.removeSnapshot(psLayerId);
    state.syncedLayers = state.syncedLayers.filter((l) => l.platformId !== platformId);
    updateLayerSection();
  } catch (err) {
    showError(`删除图层失败: ${err.message}`);
  }
  changeDetector.resume();
}

/**
 * 连接按钮
 */
async function handleConnect() {
  showError('');
  const portInput = document.getElementById('port-input');
  const portNum = portInput ? parseInt(portInput.value, 10) : state.port;
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    showError('请输入有效的端口号 (1-65535)');
    return;
  }
  state.port = portNum;
  try {
    await wsClient.connect(portNum);
  } catch (err) {
    showError(`连接失败: ${err.message}`);
  }
}

/**
 * 断开按钮
 */
function handleDisconnect() {
  changeDetector.stop();
  wsClient.disconnect();
  state.syncedLayers = [];
  state.projectName = '';
  showError('');
}

/**
 * 转义 HTML
 */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * 生成唯一 ID
 */
function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

module.exports = { renderPanel };
