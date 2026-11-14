import { Router } from 'express'
import {
  updateStep2,
  uploadStep3Documents,
  submitApplication,
  getApplicationStatus,
  getProcessingOffer,
  acceptProcessingOffer,
  uploadAvatar,
  submitRegistration,
  getMerchantByEmail,
  getMerchantTransactions,
} from '../controllers/merchant.controller.js'
import { protect } from '../middleware/auth.middleware.js'
import { uploadDocs } from '../middleware/upload.middleware.js'

const router = Router()

// Multi-step Registration Flow
router.patch('/step2', protect, updateStep2)
router.post(
  '/step3/upload',
  protect,
  uploadDocs.fields([
    { name: 'businessRegDoc', maxCount: 1 },
    { name: 'directorIdDoc', maxCount: 1 },
    { name: 'processingStatementDoc', maxCount: 1 },
  ]),
  uploadStep3Documents
)
router.post('/submit', protect, submitApplication)

// Dashboard Live Data
router.get('/status', protect, getApplicationStatus)
router.get('/offer', protect, getProcessingOffer)
router.post('/offer/accept', protect, acceptProcessingOffer)
router.post('/avatar', uploadDocs.single('avatar'), uploadAvatar)
router.patch('/avatar', uploadAvatar)
router.get('/transactions', protect, getMerchantTransactions)

// Backward-compatible fallback routes
router.post('/register', submitRegistration)
router.get('/by-email/:email', getMerchantByEmail)

export default router
