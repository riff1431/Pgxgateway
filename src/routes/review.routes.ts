import { Router } from 'express'
import {
  getPublicReviews,
  submitMerchantReview,
  getAdminReviews,
  updateReviewStatus,
  deleteReview,
} from '../controllers/review.controller.js'
import { protect } from '../middleware/auth.middleware.js'
import { adminProtect } from '../middleware/admin.middleware.js'

const router = Router()

// Public route to fetch testimonials for the homepage marquee
router.get('/public', getPublicReviews)

// Protected Merchant route to submit a new review
router.post('/submit', protect, submitMerchantReview)

// Protected Admin routes for moderating reviews
router.get('/admin', adminProtect, getAdminReviews)
router.patch('/admin/:id/status', adminProtect, updateReviewStatus)
router.delete('/admin/:id', adminProtect, deleteReview)

export default router
