import { Router } from 'express'
import {
  adminLogin,
  getApplications,
  getApplicationById,
  reviewApplication,
  extendMerchantTrial,
  convertMerchantToLive,
  requestMerchantLiveActivation,
  rejectMerchantLiveActivation,
  submitMonthlyCryptoPayment,
  deleteMerchantApplication,
  getAdminStats,
  getSystemConfig,
  updateSystemConfig,
  sendMessageToMerchant,
  getMerchantMessages,
  getAllMessages,
  uploadBrandingAsset,
  getResellerStripeConfig,
  updateResellerStripeConfig,
  getAdminTransactions,
  getSuperAdminAnalytics,
  markMerchantPayout,
  createResellerTenant,
  getSuperAdminResellersList,
  updateResellerStatus,
  resetResellerPassword,
  updateResellerFeeStructure,
  reassignMerchantReseller,
  triggerAdminSubscriptionCycle,
  chargeMerchantSubscriptionDirect,
  updateMerchantBridge,
  updateResellerDefaultBridge,
} from '../controllers/admin.controller.js'
import { adminProtect, superAdminOnly, platformAdminOnly } from '../middleware/admin.middleware.js'
import { handleReconcilePendingTransactions } from '../controllers/webhook.controller.js'
import { uploadImage } from '../middleware/upload.middleware.js'
import { authLimiter } from '../middleware/rateLimiter.js'

const router = Router()

// Public admin login (Super Admin, Root Admin, and Resellers) protected against brute-force
router.post('/login', authLimiter, adminLogin)

// Public system branding query (so frontend can read logo/title even when unauthenticated)
router.get('/config/public', getSystemConfig)

// Protected Administrative & Underwriting Endpoints
router.use(adminProtect)

router.get('/stats', getAdminStats)
router.get('/applications', getApplications)
router.get('/applications/:id', getApplicationById)
router.patch('/applications/:id/review', reviewApplication)
router.patch('/applications/:id/bridge', platformAdminOnly, updateMerchantBridge)
router.put('/applications/:id/bridge', platformAdminOnly, updateMerchantBridge)
router.post('/applications/:id/extend-trial', extendMerchantTrial)
router.post('/applications/:id/convert-live', convertMerchantToLive)
router.post('/applications/:id/request-live', requestMerchantLiveActivation)
router.post('/applications/:id/pay-monthly', submitMonthlyCryptoPayment)
router.post('/applications/:id/reject-live', superAdminOnly, rejectMerchantLiveActivation)
router.delete('/applications/:id', deleteMerchantApplication)

// Multi-Tenant Reseller & Stripe Gateway Settings
router.get('/stripe-config', getResellerStripeConfig)
router.patch('/stripe-config', updateResellerStripeConfig)
router.get('/transactions', getAdminTransactions)
router.post('/transactions/reconcile-pending', platformAdminOnly, handleReconcilePendingTransactions)
router.get('/super-analytics', superAdminOnly, getSuperAdminAnalytics)
router.post('/merchants/:merchantId/payout', markMerchantPayout)

// Super Admin Multi-Tenant Reseller Provisioning & Management
router.get('/super-resellers', superAdminOnly, getSuperAdminResellersList)
router.post('/super-resellers', superAdminOnly, createResellerTenant)
router.patch('/super-resellers/:resellerId/status', superAdminOnly, updateResellerStatus)
router.post('/super-resellers/:resellerId/reset-password', superAdminOnly, resetResellerPassword)
router.patch('/super-resellers/:resellerId/fees', superAdminOnly, updateResellerFeeStructure)
router.patch('/super-resellers/:resellerId/bridge', superAdminOnly, updateResellerDefaultBridge)
router.patch('/super-merchants/:merchantId/reassign', superAdminOnly, reassignMerchantReseller)

// Recurring Monthly Maintenance Subscriptions
router.post('/subscriptions/trigger-cycle', superAdminOnly, triggerAdminSubscriptionCycle)
router.post('/merchants/:merchantId/charge-subscription', superAdminOnly, chargeMerchantSubscriptionDirect)

// White-Label & System Branding Configuration (Exclusively Super Admin)
router.get('/config', getSystemConfig)
router.patch('/config', superAdminOnly, updateSystemConfig)
router.post('/upload-branding', superAdminOnly, uploadImage.single('file'), uploadBrandingAsset)

// Two-Way Direct Messaging with Merchants
router.post('/merchants/:id/message', sendMessageToMerchant)
router.get('/merchants/:id/messages', getMerchantMessages)
router.get('/messages/all', getAllMessages)

export default router
