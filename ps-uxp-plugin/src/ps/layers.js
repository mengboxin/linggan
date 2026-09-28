/**
 * 图层操作模块
 * 提供图层导出、导入、属性更新、排序和删除功能
 */
const { app, action } = require('photoshop');
const { executeAsModal } = require('photoshop').core;

/**
 * 导出单个图层为 PNG base64
 * @param {number} psLayerId - Photoshop 图层 ID
 * @returns {Promise<string>} PNG 图片的 base64 编码字符串
 */
async function exportLayerAsPng(psLayerId) {
  const { storage } = require('uxp');
  const fs = storage.localFileSystem;

  let base64Result = '';

  await executeAsModal(async () => {
    const doc = app.activeDocument;

    // 保存当前选中的图层
    const previousActiveLayers = doc.activeLayers.map((l) => l.id);

    // 选中目标图层
    await action.batchPlay(
      [
        {
          _obj: 'select',
          _target: [{ _ref: 'layer', _id: psLayerId }],
          makeVisible: false
        }
      ],
      {}
    );

    // 创建临时文件用于导出
    const tempFolder = await fs.getTemporaryFolder();
    const tempFile = await tempFolder.createFile('export_layer.png', { overwrite: true });

    // 复制图层内容到剪贴板，然后创建新文档粘贴并导出
    // 使用 duplicate + export 方式导出单个图层
    await action.batchPlay(
      [
        {
          _obj: 'duplicate',
          _target: [{ _ref: 'layer', _id: psLayerId }],
          to: {
            _ref: 'document',
            _name: '__temp_export__'
          }
        }
      ],
      {}
    );

    // 切换到临时文档
    const tempDoc = app.documents.find((d) => d.name === '__temp_export__');
    if (tempDoc) {
      // 合并可见图层
      await action.batchPlay(
        [
          {
            _obj: 'flattenImage'
          }
        ],
        {}
      );

      // 导出为 PNG
      await action.batchPlay(
        [
          {
            _obj: 'save',
            as: {
              _obj: 'PNGFormat',
              interlace: false
            },
            in: {
              _path: tempFile.nativePath,
              _kind: 'local'
            },
            copy: true
          }
        ],
        {}
      );

      // 关闭临时文档（不保存）
      await action.batchPlay(
        [
          {
            _obj: 'close',
            saving: { _enum: 'yesNo', _value: 'no' }
          }
        ],
        {}
      );
    }

    // 读取导出的 PNG 文件并转为 base64
    const fileData = await tempFile.read({ format: storage.formats.binary });
    base64Result = _arrayBufferToBase64(fileData);

    // 清理临时文件
    try {
      await tempFile.delete();
    } catch (e) {
      // 忽略清理失败
    }

    // 恢复之前选中的图层
    if (previousActiveLayers.length > 0) {
      await action.batchPlay(
        [
          {
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: previousActiveLayers[0] }],
            makeVisible: false
          }
        ],
        {}
      );
    }
  }, { commandName: 'PixelScribe: 导出图层' });

  return base64Result;
}

/**
 * 从 base64 数据创建新图层
 * @param {string} base64 - PNG 图片的 base64 数据
 * @param {string} name - 图层名称
 * @param {number} position - 在图层栈中的位置（0 = bottom）
 * @returns {Promise<number>} 新创建的 PS 图层 ID
 */
async function importLayerFromBase64(base64, name, position) {
  const { storage } = require('uxp');
  const fs = storage.localFileSystem;
  let newLayerId = -1;

  await executeAsModal(async () => {
    // 将 base64 写入临时文件
    const tempFolder = await fs.getTemporaryFolder();
    const tempFile = await tempFolder.createFile('import_layer.png', { overwrite: true });
    const binaryData = _base64ToArrayBuffer(base64);
    await tempFile.write(binaryData, { format: storage.formats.binary });

    // 放置图片为新图层
    await action.batchPlay(
      [
        {
          _obj: 'placeEvent',
          null: {
            _path: tempFile.nativePath,
            _kind: 'local'
          },
          freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
          linked: false
        }
      ],
      {}
    );

    // 栅格化
    await action.batchPlay(
      [
        {
          _obj: 'rasterizeLayer',
          _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
        }
      ],
      {}
    );

    // 设置图层名称
    await action.batchPlay(
      [
        {
          _obj: 'set',
          _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
          to: {
            _obj: 'layer',
            name: name
          }
        }
      ],
      {}
    );

    // 获取新图层 ID
    const doc = app.activeDocument;
    const activeLayer = doc.activeLayers[0];
    newLayerId = activeLayer.id;

    // 移动图层到指定位置
    // PS 中图层索引从上到下，需要转换
    const totalLayers = doc.layers.length;
    const targetIndex = totalLayers - 1 - position; // 转换为 PS 的从上到下索引

    if (targetIndex >= 0 && targetIndex < totalLayers) {
      await action.batchPlay(
        [
          {
            _obj: 'move',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            to: { _ref: 'layer', _index: targetIndex }
          }
        ],
        {}
      );
    }

    // 清理临时文件
    try {
      await tempFile.delete();
    } catch (e) {
      // 忽略
    }
  }, { commandName: 'PixelScribe: 导入图层' });

  return newLayerId;
}

/**
 * 更新图层属性（名称、可见性、不透明度）
 * @param {number} psLayerId - PS 图层 ID
 * @param {{name?: string, visible?: boolean, opacity?: number}} props - 要更新的属性
 */
async function updateLayerProperties(psLayerId, props) {
  await executeAsModal(async () => {
    // 选中目标图层
    await action.batchPlay(
      [
        {
          _obj: 'select',
          _target: [{ _ref: 'layer', _id: psLayerId }],
          makeVisible: false
        }
      ],
      {}
    );

    // 更新名称
    if (props.name !== undefined) {
      await action.batchPlay(
        [
          {
            _obj: 'set',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            to: {
              _obj: 'layer',
              name: props.name
            }
          }
        ],
        {}
      );
    }

    // 更新可见性
    if (props.visible !== undefined) {
      const visAction = props.visible ? 'show' : 'hide';
      await action.batchPlay(
        [
          {
            _obj: visAction,
            null: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
          }
        ],
        {}
      );
    }

    // 更新不透明度 (0-1 → 0-100)
    if (props.opacity !== undefined) {
      const psOpacity = Math.round(props.opacity * 100);
      await action.batchPlay(
        [
          {
            _obj: 'set',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            to: {
              _obj: 'layer',
              opacity: { _unit: 'percentUnit', _value: psOpacity }
            }
          }
        ],
        {}
      );
    }
  }, { commandName: 'PixelScribe: 更新图层属性' });
}

/**
 * 调整图层顺序
 * @param {number[]} orderedPsLayerIds - 按新顺序排列的 PS 图层 ID 数组（index 0 = bottom）
 */
async function reorderLayers(orderedPsLayerIds) {
  await executeAsModal(async () => {
    // 算法：从底部开始（orderedPsLayerIds[0]），依次将每个图层移到当前栈的最底部
    // 这样最后处理的图层（index = length-1，即栈顶）会位于最顶部
    // 注：PS 中 'back' = 最底部，'front' = 最顶部
    for (let i = 0; i < orderedPsLayerIds.length; i++) {
      const layerId = orderedPsLayerIds[i];

      // 选中图层
      await action.batchPlay(
        [
          {
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: layerId }],
            makeVisible: false
          }
        ],
        {}
      );

      // 移动到文档最底部
      await action.batchPlay(
        [
          {
            _obj: 'move',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            to: { _ref: 'layer', _enum: 'ordinal', _value: 'back' }
          }
        ],
        {}
      );
    }
  }, { commandName: 'PixelScribe: 调整图层顺序' });
}

/**
 * 删除图层
 * @param {number} psLayerId - 要删除的 PS 图层 ID
 */
async function deleteLayer(psLayerId) {
  await executeAsModal(async () => {
    await action.batchPlay(
      [
        {
          _obj: 'delete',
          _target: [{ _ref: 'layer', _id: psLayerId }]
        }
      ],
      {}
    );
  }, { commandName: 'PixelScribe: 删除图层' });
}

/**
 * 将 ArrayBuffer 转换为 base64 字符串
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function _arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 将 base64 字符串转换为 ArrayBuffer
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
function _base64ToArrayBuffer(base64) {
  const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
  const binaryString = atob(cleanBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

module.exports = {
  exportLayerAsPng,
  importLayerFromBase64,
  updateLayerProperties,
  reorderLayers,
  deleteLayer
};
