/**
 * 云同步管理器
 * 支持项目云存储、多设备同步、离线模式等功能
 */

export interface CloudProject {
  id: string
  name: string
  created_at: string
  updated_at: string
  file_size: number
  owner_id: string
  collaborators: string[]
  is_public: boolean
  tags: string[]
  last_synced_at?: string
  version: number
}

export interface SyncStatus {
  status: 'idle' | 'syncing' | 'conflict' | 'error' | 'completed'
  progress: number
  message: string
  last_sync: string | null
  conflicts: Array<{
    type: 'overwrite' | 'merge' | 'keep_local' | 'keep_remote'
    local_file?: string
    remote_file?: string
    description: string
  }>
}

export interface CloudConfig {
  provider: 'dropbox' | 'google-drive' | 'onedrive' | 'custom'
  api_url: string
  auth_token?: string
  refresh_token?: string
  expires_at?: number
  quota_used: number
  quota_total: number
}

class CloudSyncManager {
  private config: CloudConfig | null = null
  private syncStatus: SyncStatus = {
    status: 'idle',
    progress: 0,
    message: '',
    last_sync: null,
    conflicts: []
  }
  private isAutoSyncEnabled = true
  private syncInterval: number = 5 * 60 * 1000 // 5分钟
  private syncTimer: NodeJS.Timeout | null = null
  private syncInProgress = false
  private pendingSyncs: Array<{ type: 'upload' | 'download'; projectId: string }> = []

  constructor() {
    // 从本地存储加载配置
    this.loadConfig()
  }

  // 配置管理
  private loadConfig(): void {
    const saved = localStorage.getItem('cloud_sync_config')
    if (saved) {
      this.config = JSON.parse(saved)
    }
  }

  private saveConfig(): void {
    if (this.config) {
      localStorage.setItem('cloud_sync_config', JSON.stringify(this.config))
    }
  }

  // 认证管理
  async authenticate(provider: 'dropbox' | 'google-drive' | 'onedrive'): Promise<boolean> {
    try {
      // 这里实现OAuth认证流程
      const authUrl = this.getAuthUrl(provider)
      window.open(authUrl, '_blank')

      // 监听认证回调
      return new Promise((resolve) => {
        const checkAuth = setInterval(() => {
          const urlParams = new URLSearchParams(window.location.search)
          const code = urlParams.get('code')

          if (code) {
            clearInterval(checkAuth)
            this.exchangeCodeForToken(code, provider)
              .then(() => resolve(true))
              .catch(() => resolve(false))
          }
        }, 1000)
      })
    } catch (error) {
      console.error('Authentication failed:', error)
      return false
    }
  }

  private getAuthUrl(provider: string): string {
    // 根据不同提供商生成认证URL
    const configs = {
      'dropbox': {
        clientId: process.env.DROPBOX_CLIENT_ID,
        redirectUri: `${window.location.origin}/auth/dropbox/callback`,
        scope: 'files.content.write files.content.read'
      },
      'google-drive': {
        clientId: process.env.GOOGLE_DRIVE_CLIENT_ID,
        redirectUri: `${window.location.origin}/auth/google/callback`,
        scope: 'https://www.googleapis.com/auth/drive.file'
      },
      'onedrive': {
        clientId: process.env.ONEDRIVE_CLIENT_ID,
        redirectUri: `${window.location.origin}/auth/onedrive/callback`,
        scope: 'files.readwrite.all'
      }
    }

    const config = configs[provider as keyof typeof configs]
    if (!config) throw new Error('Unsupported provider')

    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&client_id=${config.clientId}&redirect_uri=${encodeURIComponent(config.redirectUri)}&scope=${encodeURIComponent(config.scope)}`
  }

  private async exchangeCodeForToken(code: string, provider: string): Promise<void> {
    // 实现code换取access_token的逻辑
    // 这里需要根据不同提供商实现不同的API调用
    const response = await fetch('/api/auth/cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, provider })
    })

    if (!response.ok) throw new Error('Failed to exchange code for token')

    const data = await response.json()
    this.config = {
      provider,
      api_url: data.api_url,
      auth_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      quota_used: 0,
      quota_total: data.quota_total || 15 * 1024 * 1024 * 1024 // 15GB默认
    }
    this.saveConfig()
  }

  // 同步管理
  async syncProject(projectId: string, direction: 'upload' | 'download' | 'both' = 'both'): Promise<void> {
    if (!this.config || this.syncInProgress) {
      throw new Error('No cloud configuration available or sync in progress')
    }

    this.syncInProgress = true
    this.updateSyncStatus('syncing', 0, 'Starting sync...')

    try {
      if (direction === 'upload' || direction === 'both') {
        await this.uploadProject(projectId)
      }

      if (direction === 'download' || direction === 'both') {
        await this.downloadProject(projectId)
      }

      this.updateSyncStatus('completed', 100, 'Sync completed')
      this.syncInProgress = false
    } catch (error) {
      this.updateSyncStatus('error', 0, `Sync failed: ${error.message}`)
      this.syncInProgress = false
      throw error
    }
  }

  private async uploadProject(projectId: string): Promise<void> {
    const progress = this.syncStatus.progress
    this.updateSyncStatus('syncing', progress, 'Uploading project...')

    // 1. 获取本地项目数据
    const localData = await this.loadLocalProject(projectId)

    // 2. 准备上传数据
    const blob = new Blob([JSON.stringify(localData, null, 2)], { type: 'application/json' })
    const formData = new FormData()
    formData.append('file', blob, `project_${projectId}.json`)

    // 3. 上传到云端
    const response = await fetch(`${this.config.api_url}/projects/${projectId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.config.auth_token}`
      },
      body: formData
    })

    if (!response.ok) throw new Error('Upload failed')

    // 4. 更新同步状态
    const progressInc = 25
    this.updateSyncStatus('syncing', progress + progressInc, 'Project uploaded successfully')

    // 5. 更新本地记录
    await this.updateSyncRecord(projectId, 'upload')
  }

  private async downloadProject(projectId: string): Promise<void> {
    const progress = this.syncStatus.progress
    this.updateSyncStatus('syncing', progress, 'Downloading project...')

    // 1. 获取云端数据
    const response = await fetch(`${this.config.api_url}/projects/${projectId}`, {
      headers: {
        'Authorization': `Bearer ${this.config.auth_token}`
      }
    })

    if (!response.ok) throw new Error('Download failed')

    const remoteData = await response.json()

    // 2. 检查冲突
    const conflictType = await this.checkForConflicts(projectId, remoteData)

    if (conflictType === 'overwrite') {
      // 直接覆盖
      await this.saveLocalProject(projectId, remoteData)
      this.updateSyncStatus('syncing', progress + 25, 'Project updated from cloud')
    } else if (conflictType === 'merge') {
      // 合并冲突
      const merged = await this.mergeProjectData(projectId, remoteData)
      await this.saveLocalProject(projectId, merged)
      this.updateSyncStatus('syncing', progress + 25, 'Project merged with cloud')
    } else {
      // 保持本地
      this.updateSyncStatus('syncing', progress + 25, 'Kept local version')
    }

    // 3. 更新同步记录
    await this.updateSyncRecord(projectId, 'download')
  }

  // 冲突检测与解决
  private async checkForConflicts(projectId: string, remoteData: any): Promise<'overwrite' | 'merge' | 'keep_local'> {
    const localData = await this.loadLocalProject(projectId)
    const localVersion = this.getProjectVersion(localData)
    const remoteVersion = this.getProjectVersion(remoteData)

    if (localVersion > remoteVersion) {
      return 'keep_local'
    } else if (remoteVersion > localVersion) {
      return 'overwrite'
    } else {
      // 版本相同，检查实际数据差异
      if (this.hasDataChanges(localData, remoteData)) {
        return 'merge'
      }
      return 'keep_local'
    }
  }

  private getProjectVersion(data: any): number {
    return data.metadata?.version || 0
  }

  private hasDataChanges(local: any, remote: any): boolean {
    // 简单的比较逻辑，可以根据需要实现更复杂的差异检测
    return JSON.stringify(local.layers) !== JSON.stringify(remote.layers)
  }

  private async mergeProjectData(projectId: string, remoteData: any): Promise<any> {
    const localData = await this.loadLocalProject(projectId)

    // 实现简单的合并策略
    // 新图层添加到本地
    const newLayers = remoteData.layers.filter((layer: any) =>
      !localData.layers.some((l: any) => l.id === layer.id)
    )

    return {
      ...localData,
      layers: [...localData.layers, ...newLayers],
      metadata: {
        ...localData.metadata,
        version: remoteData.metadata?.version + 1,
        last_merged: new Date().toISOString()
      }
    }
  }

  // 自动同步
  enableAutoSync(intervalMinutes: number = 5): void {
    this.isAutoSyncEnabled = true
    this.syncInterval = intervalMinutes * 60 * 1000

    if (this.syncTimer) {
      clearInterval(this.syncTimer)
    }

    this.syncTimer = setInterval(() => {
      if (this.syncInProgress) return

      // 获取所有本地项目
      const projects = this.getLocalProjects()
      projects.forEach(project => {
        this.pendingSyncs.push({ type: 'both', projectId: project.id })
      })

      // 开始同步队列中的项目
      this.processSyncQueue()
    }, this.syncInterval)
  }

  disableAutoSync(): void {
    this.isAutoSyncEnabled = false
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
  }

  private async processSyncQueue(): Promise<void> {
    if (this.pendingSyncs.length === 0 || this.syncInProgress) return

    const nextSync = this.pendingSyncs.shift()!
    try {
      await this.syncProject(nextSync.projectId, nextSync.type)
    } catch (error) {
      console.error('Auto sync failed:', error)
      // 可以添加重试逻辑
    }

    // 继续处理队列中的下一个
    this.processSyncQueue()
  }

  // 离线模式支持
  async enableOfflineMode(): Promise<void> {
    // 将当前所有项目保存到本地IndexedDB
    const projects = this.getLocalProjects()

    for (const project of projects) {
      const data = await this.loadLocalProject(project.id)
      await this.saveToIndexedDB(project.id, data)
    }
  }

  async getOfflineProject(projectId: string): Promise<any | null> {
    return await this.getFromIndexedDB(projectId)
  }

  async isProjectOfflineAvailable(projectId: string): Promise<boolean> {
    return await this.hasInIndexedDB(projectId)
  }

  // 性能优化：增量同步
  async incrementalSync(projectId: string): Promise<void> {
    if (!this.config) throw new Error('No cloud configuration available')

    // 获取上次同步时间
    const lastSync = await this.getLastSyncTime(projectId)
    if (!lastSync) {
      // 首次同步，执行完整同步
      return this.syncProject(projectId, 'both')
    }

    // 获取自上次同步以来的变更
    const changes = await this.getProjectChanges(projectId, lastSync)

    if (changes.length > 0) {
      // 只同步变更的部分
      const delta = {
        metadata: {
          version: changes[0].version,
          last_sync: new Date().toISOString()
        },
        changes
      }

      await this.uploadDelta(projectId, delta)
    }
  }

  // API封装
  async createProject(name: string, isPublic: boolean = false, tags: string[] = []): Promise<CloudProject> {
    if (!this.config) throw new Error('No cloud configuration available')

    const response = await fetch(`${this.config.api_url}/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.auth_token}`
      },
      body: JSON.stringify({ name, is_public: isPublic, tags })
    })

    if (!response.ok) throw new Error('Failed to create project')

    const project = await response.json()
    await this.saveLocalProject(project.id, {
      canvasImage: '',
      layers: [],
      metadata: { version: 1, created_at: new Date().toISOString() }
    })

    return project
  }

  async getProjects(): Promise<CloudProject[]> {
    if (!this.config) throw new Error('No cloud configuration available')

    const response = await fetch(`${this.config.api_url}/projects`, {
      headers: {
        'Authorization': `Bearer ${this.config.auth_token}`
      }
    })

    if (!response.ok) throw new Error('Failed to fetch projects')

    return await response.json()
  }

  async deleteProject(projectId: string): Promise<void> {
    if (!this.config) throw new Error('No cloud configuration available')

    const response = await fetch(`${this.config.api_url}/projects/${projectId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.config.auth_token}`
      }
    })

    if (!response.ok) throw new Error('Failed to delete project')

    // 清理本地数据
    await this.clearLocalProject(projectId)
  }

  // 本地存储操作
  private async saveLocalProject(projectId: string, data: any): Promise<void> {
    localStorage.setItem(`project_${projectId}`, JSON.stringify(data))
  }

  private async loadLocalProject(projectId: string): Promise<any> {
    const data = localStorage.getItem(`project_${projectId}`)
    return data ? JSON.parse(data) : null
  }

  private async clearLocalProject(projectId: string): Promise<void> {
    localStorage.removeItem(`project_${projectId}`)
  }

  private async getLocalProjects(): Promise<Array<{ id: string; name: string }>> {
    const projects = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('project_')) {
        const projectId = key.replace('project_', '')
        const data = await this.loadLocalProject(projectId)
        projects.push({
          id: projectId,
          name: data.metadata?.name || projectId
        })
      }
    }
    return projects
  }

  // IndexedDB操作（用于离线存储）
  private async saveToIndexedDB(projectId: string, data: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('CloudSyncDB', 1)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('projects', 'readwrite')
        const store = transaction.objectStore('projects')

        store.put({ id: projectId, data, timestamp: Date.now() })

        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      }

      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('projects', { keyPath: 'id' })
      }
    })
  }

  private async getFromIndexedDB(projectId: string): Promise<any | null> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('CloudSyncDB', 1)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('projects', 'readonly')
        const store = transaction.objectStore('projects')
        const getRequest = store.get(projectId)

        getRequest.onsuccess = () => resolve(getRequest.result?.data)
        getRequest.onerror = () => reject(getRequest.error)
      }
    })
  }

  private async hasInIndexedDB(projectId: string): Promise<boolean> {
    const data = await this.getFromIndexedDB(projectId)
    return data !== null
  }

  // 同步状态管理
  getSyncStatus(): SyncStatus {
    return { ...this.syncStatus }
  }

  private updateSyncStatus(status: SyncStatus['status'], progress: number, message: string): void {
    this.syncStatus = {
      ...this.syncStatus,
      status,
      progress,
      message
    }

    // 触发状态更新事件
    window.dispatchEvent(new CustomEvent('cloud-sync-status', {
      detail: this.syncStatus
    }))
  }

  async getLastSyncTime(projectId: string): Promise<Date | null> {
    const record = localStorage.getItem(`sync_record_${projectId}`)
    return record ? new Date(JSON.parse(record).last_sync) : null
  }

  async updateSyncRecord(projectId: string, type: 'upload' | 'download'): Promise<void> {
    const record = {
      type,
      timestamp: new Date().toISOString(),
      project_id: projectId
    }
    localStorage.setItem(`sync_record_${projectId}`, JSON.stringify(record))
  }

  // 检查云存储配额
  async checkQuota(): Promise<{ used: number; total: number; percentage: number }> {
    if (!this.config) return { used: 0, total: 0, percentage: 0 }

    const response = await fetch(`${this.config.api_url}/quota`, {
      headers: { 'Authorization': `Bearer ${this.config.auth_token}` }
    })

    if (!response.ok) return { used: 0, total: 0, percentage: 0 }

    const data = await response.json()
    this.config.quota_used = data.used
    this.saveConfig()

    return {
      used: data.used,
      total: data.total,
      percentage: (data.used / data.total) * 100
    }
  }

  // 清理同步缓存
  async cleanup(): Promise<void> {
    // 清理旧的同步记录
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('sync_record_')) {
        const projectData = JSON.parse(localStorage.getItem(key)!)
        const lastSync = new Date(projectData.timestamp)
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

        if (lastSync < thirtyDaysAgo) {
          localStorage.removeItem(key)
        }
      }
    }

    // 压缩本地存储（如果使用量过大）
    const quota = await this.checkQuota()
    if (quota.percentage > 80) {
      await this.compressLocalStorage()
    }
  }

  private async compressLocalStorage(): Promise<void> {
    // 删除最旧的未同步项目
    const projects = await this.getLocalProjects()
    projects.sort((a, b) => {
      const aTime = localStorage.getItem(`sync_record_${a.id}`) ?
        new Date(JSON.parse(localStorage.getItem(`sync_record_${a.id}`)!).timestamp).getTime() : 0
      const bTime = localStorage.getItem(`sync_record_${b.id}`) ?
        new Date(JSON.parse(localStorage.getItem(`sync_record_${b.id}`)!).timestamp).getTime() : 0
      return aTime - bTime
    })

    // 删除最旧的一半项目
    const toDelete = projects.slice(0, Math.floor(projects.length / 2))
    for (const project of toDelete) {
      await this.clearLocalProject(project.id)
    }
  }
}

// 全局实例
export const cloudSyncManager = new CloudSyncManager()

// React Hook
export function useCloudSync() {
  return cloudSyncManager
}

// 云同步状态组件
export function CloudSyncStatus() {
  const [status, setStatus] = useState(cloudSyncManager.getSyncStatus())

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      setStatus(event.detail)
    }

    window.addEventListener('cloud-sync-status', handler)
    return () => window.removeEventListener('cloud-sync-status', handler)
  }, [])

  if (status.status === 'idle') return null

  return (
    <div className={`fixed bottom-4 right-4 z-50 p-3 rounded-lg shadow-lg ${
      status.status === 'error' ? 'bg-red-500' :
      status.status === 'conflict' ? 'bg-yellow-500' : 'bg-blue-500'
    } text-white`}>
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${
          status.status === 'syncing' ? 'animate-pulse bg-white' : 'bg-white'
        }`} />
        <span className="text-sm">{status.message}</span>
        {status.status === 'syncing' && (
          <span className="text-xs opacity-75">{status.progress}%</span>
        )}
      </div>

      {status.conflicts.length > 0 && (
        <div className="mt-2 text-xs space-y-1">
          {status.conflicts.map((conflict, i) => (
            <div key={i} className="bg-white/20 rounded px-2 py-1">
              {conflict.description}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}