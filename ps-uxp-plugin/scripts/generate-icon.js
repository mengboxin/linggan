/**
 * generate-icon.js — 生成 PS UXP 插件图标
 *
 * 将项目的 logo.svg 转换为 23x23 PNG 图标文件。
 *
 * 使用方法：
 *   1. 安装依赖：npm install sharp
 *   2. 运行脚本：node ps-uxp-plugin/scripts/generate-icon.js
 *
 * 或者手动操作：
 *   - 使用任意图片编辑工具将 frontend/public/logo.svg 导出为 23x23 的 PNG
 *   - 保存到 ps-uxp-plugin/icons/icon.png
 *
 * 注意：UXP 插件图标要求为 23x23 像素的 PNG 格式
 */

const path = require('path')
const fs = require('fs')

async function generateIcon() {
  const inputPath = path.resolve(__dirname, '../../frontend/public/logo.svg')
  const outputPath = path.resolve(__dirname, '../icons/icon.png')

  if (!fs.existsSync(inputPath)) {
    console.error('❌ 找不到源文件:', inputPath)
    console.log('   请确保 frontend/public/logo.svg 存在')
    process.exit(1)
  }

  try {
    // 尝试使用 sharp（需要先安装：npm install sharp）
    const sharp = require('sharp')

    await sharp(inputPath)
      .resize(23, 23, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(outputPath)

    console.log('✅ 图标已生成:', outputPath)
    console.log('   尺寸: 23x23 PNG')
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.error('❌ 需要安装 sharp 依赖')
      console.log('')
      console.log('   请运行: npm install sharp')
      console.log('')
      console.log('   或者手动将 logo.svg 转换为 23x23 PNG 并保存到:')
      console.log('   ' + outputPath)
    } else {
      console.error('❌ 生成图标失败:', err.message)
    }
    process.exit(1)
  }
}

generateIcon()
