/**
 * PS 文档操作模块
 * 使用 batchPlay API 创建和管理 PSD 文档
 */
const { app, action } = require('photoshop');
const { executeAsModal } = require('photoshop').core;

/**
 * 创建 PSD 文档并按顺序创建图层
 * @param {Array<{platformId: string, name: string, imageBase64: string, visible: boolean, opacity: number, order: number}>} layers - 图层数据数组（index 0 = bottom）
 * @param {string} projectName - 项目名称，用作文档名
 * @param {number} [canvasWidth=1920] - 画布宽度
 * @param {number} [canvasHeight=1080] - 画布高度
 * @returns {Promise<Array<{platformId: string, psLayerId: number}>>} 创建的图层 ID 映射列表
 */
async function createDocument(layers, projectName, canvasWidth = 1920, canvasHeight = 1080) {
  const idMappings = [];

  await executeAsModal(async () => {
    // 1. 创建新文档
    await action.batchPlay(
      [
        {
          _obj: 'make',
          new: {
            _obj: 'document',
            name: projectName || 'Linggan Sync',
            width: { _unit: 'pixelsUnit', _value: canvasWidth },
            height: { _unit: 'pixelsUnit', _value: canvasHeight },
            resolution: { _unit: 'densityUnit', _value: 72 },
            mode: { _class: 'RGBColorMode' },
            depth: 8,
            fill: { _enum: 'fill', _value: 'transparent' }
          }
        }
      ],
      {}
    );

    // 2. 删除默认的背景图层
    try {
      await action.batchPlay(
        [
          {
            _obj: 'delete',
            _target: [{ _ref: 'layer', _name: 'Background' }]
          }
        ],
        {}
      );
    } catch (e) {
      // 如果没有背景图层，忽略错误
      console.log('[Document] 无默认背景图层，跳过删除');
    }

    // 3. 按顺序创建图层（index 0 = bottom，先创建底部图层）
    // 按 order 排序确保正确的创建顺序
    const sortedLayers = [...layers].sort((a, b) => a.order - b.order);

    for (const layer of sortedLayers) {
      try {
        const psLayerId = await _createLayerFromBase64(
          layer.imageBase64,
          layer.name,
          layer.visible,
          layer.opacity
        );

        idMappings.push({
          platformId: layer.platformId,
          psLayerId: psLayerId
        });
      } catch (err) {
        console.error(`[Document] 创建图层 "${layer.name}" 失败:`, err);
        // 记录失败但继续处理其余图层
        idMappings.push({
          platformId: layer.platformId,
          psLayerId: -1,
          error: err.message
        });
      }
    }
  }, { commandName: 'PixelScribe: 创建同步文档' });

  return idMappings;
}

/**
 * 从 base64 数据创建单个图层
 * @param {string} imageBase64 - PNG 图片的 base64 数据（不含 data URI 前缀）
 * @param {string} name - 图层名称
 * @param {boolean} visible - 是否可见
 * @param {number} opacity - 不透明度 (0-1)
 * @returns {Promise<number>} 创建的 PS 图层 ID
 */
async function _createLayerFromBase64(imageBase64, name, visible, opacity) {
  // 将 base64 解码为临时文件，然后作为图层放置
  const { storage } = require('uxp');
  const fs = storage.localFileSystem;

  // 创建临时文件
  const tempFolder = await fs.getTemporaryFolder();
  const tempFile = await tempFolder.createFile('temp_layer.png', { overwrite: true });

  // 将 base64 写入临时文件
  const binaryData = _base64ToArrayBuffer(imageBase64);
  await tempFile.write(binaryData, { format: storage.formats.binary });

  // 使用 batchPlay 将图片放置为新图层
  const placeResult = await action.batchPlay(
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

  // 栅格化放置的图层（确保是像素图层）
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

  // 设置图层可见性
  if (!visible) {
    await action.batchPlay(
      [
        {
          _obj: 'hide',
          null: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
        }
      ],
      {}
    );
  }

  // 设置图层不透明度 (0-1 → 0-100)
  const psOpacity = Math.round(opacity * 100);
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

  // 获取当前图层的 PS layer ID
  const doc = app.activeDocument;
  const activeLayer = doc.activeLayers[0];
  const psLayerId = activeLayer.id;

  // 清理临时文件
  try {
    await tempFile.delete();
  } catch (e) {
    // 忽略清理失败
  }

  return psLayerId;
}

/**
 * 将 base64 字符串转换为 ArrayBuffer
 * @param {string} base64 - base64 编码的字符串
 * @returns {ArrayBuffer}
 */
function _base64ToArrayBuffer(base64) {
  // 移除可能的 data URI 前缀
  const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
  const binaryString = atob(cleanBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

module.exports = {
  createDocument
};
