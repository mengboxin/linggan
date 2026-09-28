/**
 * Linggan Sync UXP 插件入口（原生 DOM，无需打包）
 */
const { entrypoints } = require('uxp');
const { renderPanel } = require('./panels/sync-panel');

entrypoints.setup({
  panels: {
    syncPanel: {
      show(event) {
        const root = event.node || document.getElementById('root');
        if (root) {
          renderPanel(root);
        }
      }
    }
  }
});
