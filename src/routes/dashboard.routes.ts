import { Router } from 'express'
import {
  getMessages,
  markAsRead,
  markAllAsRead,
  createSupportTicket,
} from '../controllers/dashboard.controller.js'
import { protect } from '../middleware/auth.middleware.js'

const router = Router()

router.get('/messages', protect, getMessages)
router.patch('/messages/read-all', protect, markAllAsRead)
router.patch('/messages/:id/read', protect, markAsRead)
router.post('/support', protect, createSupportTicket)

export default router
