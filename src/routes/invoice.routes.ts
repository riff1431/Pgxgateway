import { Router } from 'express'
import {
  getMerchantInvoices,
  payInvoiceViaStripe,
  uploadInvoiceProof,
  getAdminInvoices,
  generateWeeklyInvoice,
  updateAdminInvoiceStatus,
  downloadInvoicePdf,
  downloadAdminInvoicePdf,
} from '../controllers/invoice.controller.js'
import { protect } from '../middleware/auth.middleware.js'
import { adminProtect, superAdminOnly } from '../middleware/admin.middleware.js'

const router = Router()

// Merchant Invoice Routes
router.get('/', protect, getMerchantInvoices)
router.get('/:invoiceId/pdf', protect, downloadInvoicePdf)
router.post('/:invoiceId/pay-stripe', protect, payInvoiceViaStripe)
router.post('/:invoiceId/upload-proof', protect, uploadInvoiceProof)

// Super Admin Invoice Management
router.get('/admin', adminProtect, superAdminOnly, getAdminInvoices)
router.get('/admin/:invoiceId/pdf', adminProtect, superAdminOnly, downloadAdminInvoicePdf)
router.post('/admin/generate', adminProtect, superAdminOnly, generateWeeklyInvoice)
router.patch('/admin/:invoiceId/status', adminProtect, superAdminOnly, updateAdminInvoiceStatus)

export default router
