import { Router } from 'express'
import {
  getPlatformSettings,
  updatePlatformSettings,
  getMerchantSetupStatus,
  createSetupCheckoutSession,
  submitCollabDetails,
  getSetupMessages,
  sendSetupMessage,
  getAdminIntegrations,
  updateAdminIntegrationStatus,
} from '../controllers/setup.controller.js'
import { protect } from '../middleware/auth.middleware.js'
import { adminProtect, superAdminOnly } from '../middleware/admin.middleware.js'

const router = Router()

// Merchant Setup & Collab
router.get('/status', protect, getMerchantSetupStatus)
router.post('/checkout', protect, createSetupCheckoutSession)
router.post('/collab', protect, submitCollabDetails)

// Direct Messaging (accessible by authenticated Merchant or Admin)
router.get('/chat/:merchantId', getSetupMessages)
router.post('/chat/:merchantId', sendSetupMessage)

// Super Admin Management
router.get('/admin/settings', adminProtect, superAdminOnly, getPlatformSettings)
router.patch('/admin/settings', adminProtect, superAdminOnly, updatePlatformSettings)
router.get('/admin/desk', adminProtect, superAdminOnly, getAdminIntegrations)
router.patch('/admin/desk/:merchantId', adminProtect, superAdminOnly, updateAdminIntegrationStatus)

export default router
