/**
 * 变更检测模块
 * 监听 Photoshop documentChanged 事件，检测图层变更并通知 WebSocket 客户端
 */
const { app, action } = require('photoshop');
const { executeAsModal } = require('photoshop').core;
const { exportLayerAsPng } = require('./layers');

/**
 * 图层快照数据结构
 * @typedef {{
 *   name: string,
 *   visible: boolean,
 *   opacity: number,
 *   contentHash: string
 * }} LayerSnapshot
 */

class ChangeDetector {
  constructor() {
    /** @type {Map<number, LayerSnapshot>} psLayerId → 快照 */
    this._layerSnapshots = new Map();
    /** @type {number[]} 当前图层顺序（psLayerId 数组，index 0 = bottom） */
    this._layerOrder = [];
    /** @type {Function|null} 消息发送回调 */
    this._sendMessage = null;
    /** @type {Function|null} 获取 platformId 的回调 */
    this._getPlatformId = null;
    /** @type {boolean} 是否正在处理变更 */
    this._processing = false;
    /** @type {boolean} 是否已启动监听 */
    this._listening = false;
    /** @type {boolean} 是否暂停检测（用于接收平台推送时避免回环） */
    this._paused = false;
  }

  /**
   * 启动变更检测
   * @param {Function} sendMessage - 发送消息的回调 (msg) => void
   * @param {Function} getPlatformId - 获取 platformId 的回调 (psLayerId) => string|null
   */
  start(sendMessage, getPlatformId) {
    this._sendMessage = sendMessage;
    this._getPlatformId = getPlatformId;

    if (!this._listening) {
      // 保存绑定后的函数引用以便后续正确移除
      this._boundHandler = this._onDocumentChanged.bind(this);
      action.addNotificationListener(
        ['set', 'move', 'make', 'delete', 'hide', 'show', 'save'],
        this._boundHandler
      );
      this._listening = true;
      console.log('[ChangeDetector] 已启动变更监听');
    }
  }

  /**
   * 停止变更检测
   */
  stop() {
    if (this._listening && this._boundHandler) {
      try {
        action.removeNotificationListener(
          ['set', 'move', 'make', 'delete', 'hide', 'show', 'save'],
          this._boundHandler
        );
      } catch (e) {
        // 忽略移除失败
      }
      this._listening = false;
      this._boundHandler = null;
    }
    this._layerSnapshots.clear();
    this._layerOrder = [];
    console.log('[ChangeDetector] 已停止变更监听');
  }

  /**
   * 暂停变更检测（接收平台推送时使用）
   */
  pause() {
    this._paused = true;
  }

  /**
   * 恢复变更检测
   */
  resume() {
    this._paused = false;
  }

  /**
   * 初始化图层快照（推送完成后调用）
   * @param {Array<{psLayerId: number, name: string, visible: boolean, opacity: number}>} layers
   */
  async initSnapshots(layers) {
    this._layerSnapshots.clear();
    this._layerOrder = [];

    for (const layer of layers) {
      // 计算内容 hash
      const contentHash = await this._computeLayerHash(layer.psLayerId);

      this._layerSnapshots.set(layer.psLayerId, {
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
        contentHash: contentHash
      });

      this._layerOrder.push(layer.psLayerId);
    }

    console.log(`[ChangeDetector] 已初始化 ${layers.length} 个图层快照`);
  }

  /**
   * 更新单个图层的快照
   * @param {number} psLayerId
   * @param {Partial<LayerSnapshot>} updates
   */
  updateSnapshot(psLayerId, updates) {
    const existing = this._layerSnapshots.get(psLayerId);
    if (existing) {
      this._layerSnapshots.set(psLayerId, { ...existing, ...updates });
    }
  }

  /**
   * 添加新图层到快照
   * @param {number} psLayerId
   * @param {LayerSnapshot} snapshot
   * @param {number} position - 在顺序数组中的位置
   */
  addSnapshot(psLayerId, snapshot, position) {
    this._layerSnapshots.set(psLayerId, snapshot);
    this._layerOrder.splice(position, 0, psLayerId);
  }

  /**
   * 从快照中移除图层
   * @param {number} psLayerId
   */
  removeSnapshot(psLayerId) {
    this._layerSnapshots.delete(psLayerId);
    this._layerOrder = this._layerOrder.filter((id) => id !== psLayerId);
  }

  /**
   * documentChanged 事件处理器
   * @param {string} eventName
   * @param {object} descriptor
   */
  async _onDocumentChanged(eventName, descriptor) {
    // 暂停时不处理
    if (this._paused) return;

    // 避免并发处理
    if (this._processing) return;

    // 仅处理与图层相关的事件
    const layerEvents = ['set', 'move', 'make', 'delete', 'hide', 'show', 'save'];
    if (!layerEvents.includes(eventName)) return;

    this._processing = true;

    try {
      await this._detectChanges();
    } catch (err) {
      console.error('[ChangeDetector] 变更检测异常:', err);
    } finally {
      this._processing = false;
    }
  }

  /**
   * 检测所有图层变更
   */
  async _detectChanges() {
    const doc = app.activeDocument;
    if (!doc) return;

    // 获取当前文档中所有图层的状态
    const currentLayers = this._getCurrentLayers(doc);
    const currentLayerIds = new Set(currentLayers.map((l) => l.id));
    const snapshotLayerIds = new Set(this._layerSnapshots.keys());

    // 检测删除的图层
    for (const psLayerId of snapshotLayerIds) {
      if (!currentLayerIds.has(psLayerId)) {
        await this._handleLayerDeleted(psLayerId);
      }
    }

    // 检测新增的图层
    for (const layer of currentLayers) {
      if (!snapshotLayerIds.has(layer.id)) {
        await this._handleLayerAdded(layer, currentLayers);
      }
    }

    // 检测属性和内容变更
    for (const layer of currentLayers) {
      if (snapshotLayerIds.has(layer.id)) {
        await this._checkLayerChanges(layer);
      }
    }

    // 检测顺序变更
    const currentOrder = currentLayers.map((l) => l.id);
    if (!this._arraysEqual(currentOrder, this._layerOrder)) {
      await this._handleOrderChanged(currentOrder);
    }
  }

  /**
   * 获取当前文档的图层列表（从底到顶）
   * @param {object} doc - PS 文档对象
   * @returns {Array<{id: number, name: string, visible: boolean, opacity: number}>}
   */
  _getCurrentLayers(doc) {
    const layers = [];
    // PS 的 doc.layers 是从上到下排列的，需要反转为从底到顶
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      layers.push({
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity / 100 // PS 使用 0-100，转为 0-1
      });
    }
    return layers;
  }

  /**
   * 检查单个图层的属性和内容变更
   * @param {{id: number, name: string, visible: boolean, opacity: number}} layer
   */
  async _checkLayerChanges(layer) {
    const snapshot = this._layerSnapshots.get(layer.id);
    if (!snapshot) return;

    const platformId = this._getPlatformId(layer.id);
    if (!platformId) return;

    // 检测属性变更
    const changes = {};
    if (layer.name !== snapshot.name) changes.name = layer.name;
    if (layer.visible !== snapshot.visible) changes.visible = layer.visible;
    if (Math.abs(layer.opacity - snapshot.opacity) > 0.001) changes.opacity = layer.opacity;

    if (Object.keys(changes).length > 0) {
      this._sendMessage({
        type: 'property-changed',
        payload: {
          platformId: platformId,
          psLayerId: layer.id,
          changes: changes
        },
        timestamp: new Date().toISOString(),
        messageId: this._generateId()
      });

      // 更新快照
      this._layerSnapshots.set(layer.id, {
        ...snapshot,
        ...changes,
        // 保留 contentHash
        contentHash: snapshot.contentHash
      });
    }

    // 检测内容变更（通过 hash 对比）
    const currentHash = await this._computeLayerHash(layer.id);
    if (currentHash !== snapshot.contentHash) {
      // 内容发生变更，导出图层并发送
      const imageBase64 = await exportLayerAsPng(layer.id);

      this._sendMessage({
        type: 'layer-updated',
        payload: {
          platformId: platformId,
          psLayerId: layer.id,
          imageBase64: imageBase64
        },
        timestamp: new Date().toISOString(),
        messageId: this._generateId()
      });

      // 更新快照中的 hash
      snapshot.contentHash = currentHash;
      this._layerSnapshots.set(layer.id, snapshot);
    }
  }

  /**
   * 处理图层删除
   * @param {number} psLayerId
   */
  async _handleLayerDeleted(psLayerId) {
    const platformId = this._getPlatformId(psLayerId);
    if (!platformId) return;

    this._sendMessage({
      type: 'layer-deleted',
      payload: {
        platformId: platformId,
        psLayerId: psLayerId
      },
      timestamp: new Date().toISOString(),
      messageId: this._generateId()
    });

    // 从快照中移除
    this.removeSnapshot(psLayerId);
  }

  /**
   * 处理图层新增
   * @param {{id: number, name: string, visible: boolean, opacity: number}} layer
   * @param {Array} currentLayers - 当前所有图层
   */
  async _handleLayerAdded(layer, currentLayers) {
    // 导出新图层内容
    const imageBase64 = await exportLayerAsPng(layer.id);

    // 确定位置（在当前图层列表中的索引）
    const position = currentLayers.findIndex((l) => l.id === layer.id);

    this._sendMessage({
      type: 'layer-added',
      payload: {
        psLayerId: layer.id,
        name: layer.name,
        imageBase64: imageBase64,
        position: position,
        visible: layer.visible,
        opacity: layer.opacity
      },
      timestamp: new Date().toISOString(),
      messageId: this._generateId()
    });

    // 计算 hash 并添加到快照
    const contentHash = await this._computeLayerHash(layer.id);
    this.addSnapshot(layer.id, {
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      contentHash: contentHash
    }, position);
  }

  /**
   * 处理图层顺序变更
   * @param {number[]} newOrder - 新的图层顺序（psLayerId 数组，index 0 = bottom）
   */
  async _handleOrderChanged(newOrder) {
    // 将 psLayerIds 映射为 platformIds
    const orderedPlatformIds = [];
    for (const psLayerId of newOrder) {
      const platformId = this._getPlatformId(psLayerId);
      if (platformId) {
        orderedPlatformIds.push(platformId);
      }
    }

    if (orderedPlatformIds.length > 0) {
      this._sendMessage({
        type: 'order-changed',
        payload: {
          orderedIds: orderedPlatformIds
        },
        timestamp: new Date().toISOString(),
        messageId: this._generateId()
      });
    }

    // 更新顺序快照
    this._layerOrder = [...newOrder];
  }

  /**
   * 计算图层内容的 hash（简化版：使用图层像素边界作为近似 hash）
   * 注意：完整的内容 hash 需要导出图层并计算，这里使用图层边界 + 修改计数作为近似
   * @param {number} psLayerId
   * @returns {Promise<string>}
   */
  async _computeLayerHash(psLayerId) {
    try {
      const result = await action.batchPlay(
        [
          {
            _obj: 'get',
            _target: [
              { _property: 'bounds' },
              { _ref: 'layer', _id: psLayerId }
            ]
          }
        ],
        {}
      );

      if (result && result[0]) {
        const bounds = result[0].bounds;
        // 使用边界信息 + 当前时间戳的组合作为简化 hash
        // 实际生产中应使用像素数据的真实 hash
        return `${bounds?.top?._value || 0}_${bounds?.left?._value || 0}_${bounds?.bottom?._value || 0}_${bounds?.right?._value || 0}_${Date.now()}`;
      }
    } catch (e) {
      // 获取失败时返回随机 hash（触发内容变更检测）
    }
    return `unknown_${Date.now()}`;
  }

  /**
   * 比较两个数组是否相等
   * @param {any[]} a
   * @param {any[]} b
   * @returns {boolean}
   */
  _arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * 生成唯一 ID
   * @returns {string}
   */
  _generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

// 导出单例
const changeDetector = new ChangeDetector();
module.exports = changeDetector;
