import { Router } from 'express'
import {
  adminLogin,
  getApplications,
  getApplicationById,
  reviewApplication,
  getAdminStats,
  getSystemConfig,
  updateSystemConfig,
  sendMessageToMerchant,
  getMerchantMessages,
} from '../controllers/admin.controller.js'
import { adminProtect } from '../middleware/admin.middleware.js'

const router = Router()

// Public admin login
router.post('/login', adminLogin)

// Public system branding query (so frontend can read logo/title even when unauthenticated)
router.get('/config/public', getSystemConfig)

// Protected Administrative & Underwriting Endpoints
router.use(adminProtect)

router.get('/stats', getAdminStats)
router.get('/applications', getApplications)
router.get('/applications/:id', getApplicationById)
router.patch('/applications/:id/review', reviewApplication)

// White-Label & System Branding Configuration
router.get('/config', getSystemConfig)
router.patch('/config', updateSystemConfig)

// Two-Way Direct Messaging with Merchants
router.post('/merchants/:id/message', sendMessageToMerchant)
router.get('/merchants/:id/messages', getMerchantMessages)

export default router
