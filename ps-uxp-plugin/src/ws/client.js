/**
 * WebSocket 客户端模块
 * 负责与 Electron 主进程的 WebSocket 服务端通信
 * 支持握手、心跳、断线重连
 */

// 重连配置：指数退避，最多重试 3 次
const RECONNECT_DELAYS = [1000, 2000, 4000]; // 1s, 2s, 4s
const HANDSHAKE_TIMEOUT = 5000; // 握手超时 5 秒

class WSClient {
  constructor() {
    /** @type {WebSocket|null} */
    this._ws = null;
    /** @type {string} */
    this._url = '';
    /** @type {number} */
    this._port = 9527;
    /** @type {'disconnected'|'connecting'|'connected'} */
    this._status = 'disconnected';
    /** @type {Function[]} */
    this._messageHandlers = [];
    /** @type {Function[]} */
    this._statusChangeHandlers = [];
    /** @type {number} */
    this._reconnectAttempt = 0;
    /** @type {number|null} */
    this._reconnectTimer = null;
    /** @type {number|null} */
    this._handshakeTimer = null;
    /** @type {boolean} */
    this._intentionalClose = false;
  }

  /**
   * 获取当前连接状态
   * @returns {'disconnected'|'connecting'|'connected'}
   */
  get status() {
    return this._status;
  }

  /**
   * 获取当前连接端口
   * @returns {number}
   */
  get port() {
    return this._port;
  }

  /**
   * 连接到 WebSocket 服务端
   * @param {number} port - 服务端端口号
   * @returns {Promise<void>}
   */
  connect(port) {
    return new Promise((resolve, reject) => {
      if (this._ws && this._status === 'connected') {
        resolve();
        return;
      }

      this._port = port;
      this._url = `ws://localhost:${port}`;
      this._intentionalClose = false;
      this._reconnectAttempt = 0;

      this._doConnect(resolve, reject);
    });
  }

  /**
   * 内部连接实现
   * @param {Function} resolve - Promise resolve
   * @param {Function} reject - Promise reject
   */
  _doConnect(resolve, reject) {
    this._setStatus('connecting');

    try {
      this._ws = new WebSocket(this._url);
    } catch (err) {
      this._setStatus('disconnected');
      if (reject) reject(err);
      return;
    }

    // 连接打开时等待握手确认
    this._ws.onopen = () => {
      // 启动握手超时计时器
      this._handshakeTimer = setTimeout(() => {
        console.warn('[WSClient] 握手超时，关闭连接');
        this._ws.close();
        if (reject) reject(new Error('握手超时'));
      }, HANDSHAKE_TIMEOUT);
    };

    // 接收消息
    this._ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.error('[WSClient] 消息解析失败:', e);
        return;
      }

      // 处理握手确认
      if (msg.type === 'handshake-ack') {
        this._onHandshakeAck(msg, resolve);
        return;
      }

      // 处理 ping 消息，自动回复 pong
      if (msg.type === 'ping') {
        this._sendPong(msg);
        return;
      }

      // 分发消息给注册的处理器
      this._messageHandlers.forEach((handler) => {
        try {
          handler(msg);
        } catch (e) {
          console.error('[WSClient] 消息处理器异常:', e);
        }
      });
    };

    // 连接关闭
    this._ws.onclose = () => {
      this._clearHandshakeTimer();

      if (this._intentionalClose) {
        this._setStatus('disconnected');
        return;
      }

      // 非主动关闭，尝试重连
      this._setStatus('disconnected');
      this._attemptReconnect();
    };

    // 连接错误
    this._ws.onerror = (err) => {
      console.error('[WSClient] WebSocket 错误:', err);
      // onclose 会在 onerror 之后触发，重连逻辑在 onclose 中处理
    };
  }

  /**
   * 处理握手确认消息
   * @param {object} msg - 握手确认消息
   * @param {Function} resolve - Promise resolve
   */
  _onHandshakeAck(msg, resolve) {
    this._clearHandshakeTimer();
    this._setStatus('connected');
    this._reconnectAttempt = 0;
    console.log('[WSClient] 握手成功，协议版本:', msg.payload?.protocolVersion);
    if (resolve) resolve();
  }

  /**
   * 回复 pong 消息
   * @param {object} pingMsg - 收到的 ping 消息
   */
  _sendPong(pingMsg) {
    const pong = {
      type: 'pong',
      payload: {},
      timestamp: new Date().toISOString(),
      messageId: this._generateId()
    };
    this._rawSend(pong);
  }

  /**
   * 尝试断线重连（指数退避）
   */
  _attemptReconnect() {
    if (this._reconnectAttempt >= RECONNECT_DELAYS.length) {
      console.warn('[WSClient] 重连次数已用尽，停止重连');
      this._setStatus('disconnected');
      return;
    }

    const delay = RECONNECT_DELAYS[this._reconnectAttempt];
    console.log(`[WSClient] 将在 ${delay}ms 后尝试第 ${this._reconnectAttempt + 1} 次重连`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectAttempt++;
      this._doConnect(null, null);
    }, delay);
  }

  /**
   * 发送消息
   * @param {object} message - 要发送的协议消息
   * @returns {boolean} 是否发送成功
   */
  send(message) {
    if (!this._ws || this._status !== 'connected') {
      console.warn('[WSClient] 未连接，无法发送消息');
      return false;
    }
    return this._rawSend(message);
  }

  /**
   * 底层发送（不检查连接状态）
   * @param {object} message - 消息对象
   * @returns {boolean}
   */
  _rawSend(message) {
    try {
      this._ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      console.error('[WSClient] 发送失败:', e);
      return false;
    }
  }

  /**
   * 注册消息处理器
   * @param {Function} handler - 消息处理回调函数
   * @returns {Function} 取消注册的函数
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
    return () => {
      this._messageHandlers = this._messageHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * 注册状态变更处理器
   * @param {Function} handler - 状态变更回调
   * @returns {Function} 取消注册的函数
   */
  onStatusChange(handler) {
    this._statusChangeHandlers.push(handler);
    return () => {
      this._statusChangeHandlers = this._statusChangeHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * 优雅断开连接
   */
  disconnect() {
    this._intentionalClose = true;
    this._clearReconnectTimer();
    this._clearHandshakeTimer();

    if (this._ws) {
      // 发送 disconnect 消息通知服务端
      const disconnectMsg = {
        type: 'disconnect',
        payload: {},
        timestamp: new Date().toISOString(),
        messageId: this._generateId()
      };
      this._rawSend(disconnectMsg);

      // 关闭 WebSocket 连接
      this._ws.close();
      this._ws = null;
    }

    this._setStatus('disconnected');
  }

  /**
   * 设置连接状态并通知监听器
   * @param {'disconnected'|'connecting'|'connected'} status
   */
  _setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    this._statusChangeHandlers.forEach((handler) => {
      try {
        handler(status);
      } catch (e) {
        console.error('[WSClient] 状态变更处理器异常:', e);
      }
    });
  }

  /**
   * 清除握手超时计时器
   */
  _clearHandshakeTimer() {
    if (this._handshakeTimer) {
      clearTimeout(this._handshakeTimer);
      this._handshakeTimer = null;
    }
  }

  /**
   * 清除重连计时器
   */
  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * 生成简单的唯一 ID
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

// 导出单例实例
const wsClient = new WSClient();
module.exports = wsClient;
