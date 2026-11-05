import { Router } from 'express'
import {
  getMessages,
  sendMessage,
  markAsRead,
  markAllAsRead,
  toggleMessageLabel,
  deleteMessage,
  createSupportTicket,
} from '../controllers/dashboard.controller.js'
import { protect } from '../middleware/auth.middleware.js'

const router = Router()

// Message routes
router.get('/messages', protect, getMessages)
router.post('/messages', protect, sendMessage)
router.patch('/messages/read-all', protect, markAllAsRead)
router.patch('/messages/:id/read', protect, markAsRead)
router.patch('/messages/:id/labels', protect, toggleMessageLabel)
router.delete('/messages/:id', protect, deleteMessage)

// Support Ticket route
router.post('/support', protect, createSupportTicket)

export default router
