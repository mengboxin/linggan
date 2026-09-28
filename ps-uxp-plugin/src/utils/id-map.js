/**
 * ID 映射缓存模块
 * 维护 platformId ↔ psLayerId 的双向映射
 */

class IdMap {
  constructor() {
    /** @type {Map<string, number>} platformId → psLayerId */
    this._platformToPs = new Map();
    /** @type {Map<number, string>} psLayerId → platformId */
    this._psToPlatform = new Map();
  }

  /**
   * 设置映射关系
   * @param {string} platformId - 平台图层 ID
   * @param {number} psLayerId - Photoshop 图层 ID
   */
  setMapping(platformId, psLayerId) {
    // 清理可能存在的旧映射
    const oldPsId = this._platformToPs.get(platformId);
    if (oldPsId !== undefined) {
      this._psToPlatform.delete(oldPsId);
    }
    const oldPlatformId = this._psToPlatform.get(psLayerId);
    if (oldPlatformId !== undefined) {
      this._platformToPs.delete(oldPlatformId);
    }

    // 建立新映射
    this._platformToPs.set(platformId, psLayerId);
    this._psToPlatform.set(psLayerId, platformId);
  }

  /**
   * 通过 psLayerId 获取 platformId
   * @param {number} psLayerId - Photoshop 图层 ID
   * @returns {string|null}
   */
  getPlatformId(psLayerId) {
    return this._psToPlatform.get(psLayerId) || null;
  }

  /**
   * 通过 platformId 获取 psLayerId
   * @param {string} platformId - 平台图层 ID
   * @returns {number|null}
   */
  getPsLayerId(platformId) {
    const id = this._platformToPs.get(platformId);
    return id !== undefined ? id : null;
  }

  /**
   * 移除映射
   * @param {string} platformId - 平台图层 ID
   */
  removeMapping(platformId) {
    const psLayerId = this._platformToPs.get(platformId);
    if (psLayerId !== undefined) {
      this._psToPlatform.delete(psLayerId);
    }
    this._platformToPs.delete(platformId);
  }

  /**
   * 通过 psLayerId 移除映射
   * @param {number} psLayerId - Photoshop 图层 ID
   */
  removeMappingByPsId(psLayerId) {
    const platformId = this._psToPlatform.get(psLayerId);
    if (platformId !== undefined) {
      this._platformToPs.delete(platformId);
    }
    this._psToPlatform.delete(psLayerId);
  }

  /**
   * 从 sync-complete 消息初始化映射
   * @param {Array<{platformId: string, psLayerId: number}>} mappings - 映射数组
   */
  initFromSyncComplete(mappings) {
    this.clear();
    for (const { platformId, psLayerId } of mappings) {
      if (platformId && psLayerId > 0) {
        this.setMapping(platformId, psLayerId);
      }
    }
    console.log(`[IdMap] 已从 sync-complete 初始化 ${this._platformToPs.size} 个映射`);
  }

  /**
   * 获取所有映射
   * @returns {Array<{platformId: string, psLayerId: number}>}
   */
  getAllMappings() {
    const result = [];
    for (const [platformId, psLayerId] of this._platformToPs) {
      result.push({ platformId, psLayerId });
    }
    return result;
  }

  /**
   * 获取映射数量
   * @returns {number}
   */
  get size() {
    return this._platformToPs.size;
  }

  /**
   * 清空所有映射
   */
  clear() {
    this._platformToPs.clear();
    this._psToPlatform.clear();
  }

  /**
   * 检查是否存在 platformId 的映射
   * @param {string} platformId
   * @returns {boolean}
   */
  hasPlatformId(platformId) {
    return this._platformToPs.has(platformId);
  }

  /**
   * 检查是否存在 psLayerId 的映射
   * @param {number} psLayerId
   * @returns {boolean}
   */
  hasPsLayerId(psLayerId) {
    return this._psToPlatform.has(psLayerId);
  }
}

// 导出单例
const idMap = new IdMap();
module.exports = idMap;
