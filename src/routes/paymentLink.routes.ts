import { Router } from 'express'
import { protect } from '../middleware/auth.middleware.js'
import {
  listMerchantPaymentLinks,
  createPaymentLink,
  updatePaymentLinkStatus,
  deletePaymentLink,
  getPublicPaymentLink,
  initiatePaymentLinkCheckout,
} from '../controllers/paymentLink.controller.js'

const router = Router()

// Public shopper routes
router.get('/public/:slug', getPublicPaymentLink)
router.post('/public/:slug/checkout', initiatePaymentLinkCheckout)

// Authenticated merchant payment link management
router.get('/', protect, listMerchantPaymentLinks)
router.post('/', protect, createPaymentLink)
router.patch('/:id', protect, updatePaymentLinkStatus)
router.delete('/:id', protect, deletePaymentLink)

export default router
