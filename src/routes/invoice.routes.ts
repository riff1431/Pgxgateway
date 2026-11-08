import { Router } from 'express'
import {
  getMerchantInvoices,
  payInvoiceViaStripe,
  uploadInvoiceProof,
  getAdminInvoices,
  generateWeeklyInvoice,
  updateAdminInvoiceStatus,
} from '../controllers/invoice.controller.js'
import { protect } from '../middleware/auth.middleware.js'
import { adminProtect, superAdminOnly } from '../middleware/admin.middleware.js'

const router = Router()

// Merchant Invoice Routes
router.get('/', protect, getMerchantInvoices)
router.post('/:invoiceId/pay-stripe', protect, payInvoiceViaStripe)
router.post('/:invoiceId/upload-proof', protect, uploadInvoiceProof)

// Super Admin Invoice Management
router.get('/admin', adminProtect, superAdminOnly, getAdminInvoices)
router.post('/admin/generate', adminProtect, superAdminOnly, generateWeeklyInvoice)
router.patch('/admin/:invoiceId/status', adminProtect, superAdminOnly, updateAdminInvoiceStatus)

export default router
