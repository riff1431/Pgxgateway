import { Response, NextFunction } from 'express'
import { Notification } from '../models/Notification.js'
import { AuthRequest } from '../middleware/auth.middleware.js'

// Get all notifications/messages for the logged in merchant
export async function getMessages(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id

    const messages = await Notification.find({ merchantId }).sort({ createdAt: -1 })
    const unreadCount = await Notification.countDocuments({ merchantId, isRead: false })

    res.status(200).json({
      success: true,
      unreadCount,
      data: messages,
    })
  } catch (error) {
    next(error)
  }
}

// Mark notification as read
export async function markAsRead(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const merchantId = req.user!._id

    const notification = await Notification.findOneAndUpdate(
      { _id: id, merchantId },
      { isRead: true },
      { new: true }
    )

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found.',
      })
    }

    res.status(200).json({
      success: true,
      data: notification,
    })
  } catch (error) {
    next(error)
  }
}

// Create support ticket (Request Support > quick action)
export async function createSupportTicket(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.user!
    const { subject = 'General Inquiry', message = 'Merchant requested priority support' } = req.body

    const ticketId = `TICKET-${Date.now().toString().slice(-6)}`

    // Create confirmation notification
    await Notification.create({
      merchantId: merchant._id,
      title: `Support Ticket Created: #${ticketId}`,
      content: `Your support request has been logged. Our fintech team will reach out to ${merchant.businessEmail} within 1 hour.`,
      type: 'system',
    })

    res.status(201).json({
      success: true,
      message: 'Support ticket created successfully.',
      data: {
        ticketId,
        subject,
        message,
        status: 'open',
        priority: 'high',
        createdAt: new Date(),
      },
    })
  } catch (error) {
    next(error)
  }
}
