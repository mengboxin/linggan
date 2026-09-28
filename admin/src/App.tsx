import { Routes, Route, Navigate } from 'react-router-dom'
import AdminLogin from './pages/AdminLogin'
import AdminLayout from './layout/AdminLayout'
import Dashboard from './pages/Dashboard'
import Finance from './pages/Finance'
import Users from './pages/Users'
import Models from './pages/Models'
import UsageStats from './pages/UsageStats'
import SystemSettings from './pages/SystemSettings'
import Credits from './pages/Credits'
import Payments from './pages/Payments'
import PetConfig from './pages/PetConfig'
import DownloadConfig from './pages/DownloadConfig'
import Storage from './pages/Storage'
import PublicGalleryReview from './pages/PublicGalleryReview'
import AnnouncementConfig from './pages/AnnouncementConfig'
import CreativeStyles from './pages/CreativeStyles'
import Subscriptions from './pages/Subscriptions'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<AdminLogin />} />
      <Route path="/" element={<AdminLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="finance" element={<Finance />} />
        <Route path="payments" element={<Payments />} />
        <Route path="subscriptions" element={<Subscriptions />} />
        <Route path="storage" element={<Storage />} />
        <Route path="gallery-review" element={<PublicGalleryReview />} />
        <Route path="announcements" element={<AnnouncementConfig />} />
        <Route path="creative-styles" element={<CreativeStyles />} />
        <Route path="users" element={<Users />} />
        <Route path="credits" element={<Credits />} />
        <Route path="models" element={<Models />} />
        <Route path="usage" element={<UsageStats />} />
        <Route path="settings" element={<SystemSettings />} />
        <Route path="pet" element={<PetConfig />} />
        <Route path="download" element={<DownloadConfig />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}

export default App
