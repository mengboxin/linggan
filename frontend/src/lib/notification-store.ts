/**
 * 通知状态管理
 */
import { create } from 'zustand'

export type NotificationType = 'payment_success' | 'task_complete' | 'low_balance' | 'system' | 'error'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message: string
  read: boolean
  createdAt: number
}

interface NotificationState {
  notifications: Notification[]
  unreadCount: number
  add: (n: Omit<Notification, 'id' | 'read' | 'createdAt'>) => void
  markRead: (id: string) => void
  markAllRead: () => void
  dismiss: (id: string) => void
  clearAll: () => void
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: 0,

  add: (n) => {
    const notification: Notification = {
      ...n,
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      read: false,
      createdAt: Date.now(),
    }
    set((state) => ({
      notifications: [notification, ...state.notifications].slice(0, 50), // 最多保留50条
      unreadCount: state.unreadCount + 1,
    }))
  },

  markRead: (id) => {
    set((state) => {
      const notif = state.notifications.find((n) => n.id === id)
      if (notif && !notif.read) {
        return {
          notifications: state.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          ),
          unreadCount: Math.max(0, state.unreadCount - 1),
        }
      }
      return state
    })
  },

  markAllRead: () => {
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }))
  },

  dismiss: (id) => {
    set((state) => {
      const notif = state.notifications.find((n) => n.id === id)
      return {
        notifications: state.notifications.filter((n) => n.id !== id),
        unreadCount: notif && !notif.read
          ? Math.max(0, state.unreadCount - 1)
          : state.unreadCount,
      }
    })
  },

  clearAll: () => {
    set({ notifications: [], unreadCount: 0 })
  },
}))
