import { Response, NextFunction } from 'express'
import { Notification } from '../models/Notification.js'
import { AuthRequest } from '../middleware/auth.middleware.js'
import { emitToMerchant, emitToAdmins, WS_EVENTS } from '../services/socket.service.js'

// Get all notifications/messages for the logged in merchant with search and label filters
export async function getMessages(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const { search, label, type, unreadOnly } = req.query

    const filter: Record<string, unknown> = { merchantId }

    if (unreadOnly === 'true') {
      filter.isRead = false
    }

    if (type && type !== 'all') {
      filter.type = type
    }

    if (label && label !== 'all') {
      filter.labels = label
    }

    if (search && typeof search === 'string') {
      const regex = new RegExp(search.trim(), 'i')
      filter.$or = [{ title: regex }, { content: regex }, { senderName: regex }]
    }

    const messages = await Notification.find(filter).sort({ createdAt: -1 })
    const unreadCount = await Notification.countDocuments({ merchantId, isRead: false })

    // Aggregate distinct labels used by this merchant for easy UI filtering
    const allMerchantMessages = await Notification.find({ merchantId }, { labels: 1 })
    const labelSet = new Set<string>()
    allMerchantMessages.forEach((msg) => {
      if (Array.isArray(msg.labels)) {
        msg.labels.forEach((lbl) => labelSet.add(lbl))
      }
    })

    res.status(200).json({
      success: true,
      unreadCount,
      total: messages.length,
      availableLabels: Array.from(labelSet),
      data: messages,
    })
  } catch (error) {
    next(error)
  }
}

// Send a two-way message from merchant to Underwriting Desk
export async function sendMessage(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.user!
    const {
      title,
      content,
      type = 'support',
      priority = 'normal',
      labels = ['Inquiry'],
      replyTo = null,
    } = req.body

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        message: 'Message subject and content are required.',
      })
    }

    // Default label array sanitized
    const sanitizedLabels = Array.isArray(labels)
      ? labels.filter((l: string) => typeof l === 'string' && l.trim().length > 0)
      : ['Inquiry']

    const message = await Notification.create({
      merchantId: merchant._id,
      senderRole: 'merchant',
      senderName: merchant.legalName || merchant.fullName,
      title: title.trim(),
      content: content.trim(),
      type: ['system', 'offer', 'document', 'general', 'compliance', 'support'].includes(type)
        ? type
        : 'support',
      labels: sanitizedLabels,
      priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal',
      isRead: true, // Merchant already read what they wrote
      readAt: new Date(),
      replyTo: replyTo || null,
      metadata: {
        merchantEmail: merchant.businessEmail,
        merchantPhone: merchant.phone,
      },
    })

    const unreadCount = await Notification.countDocuments({
      merchantId: merchant._id,
      isRead: false,
    })

    // Broadcast to Admin Desk
    emitToAdmins(WS_EVENTS.NEW_MESSAGE, {
      message,
      merchant: {
        id: merchant._id,
        fullName: merchant.fullName,
        legalName: merchant.legalName,
        email: merchant.businessEmail,
      },
      unreadCount,
    })

    // Also emit to the merchant room for immediate local synchronization
    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_MESSAGE, {
      notification: message,
      message,
      unreadCount,
    })

    res.status(201).json({
      success: true,
      message: 'Message dispatched to underwriting desk.',
      data: message,
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
      { isRead: true, readAt: new Date() },
      { new: true }
    )

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found.',
      })
    }

    const unreadCount = await Notification.countDocuments({ merchantId, isRead: false })

    // Real-time WebSocket emission for read sync across tabs/devices
    emitToMerchant(String(merchantId), WS_EVENTS.MESSAGE_READ, {
      id: notification._id,
      isRead: true,
      readAt: notification.readAt,
      unreadCount,
    })

    res.status(200).json({
      success: true,
      unreadCount,
      data: notification,
    })
  } catch (error) {
    next(error)
  }
}

// Mark ALL notifications as read
export async function markAllAsRead(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id

    await Notification.updateMany(
      { merchantId, isRead: false },
      { isRead: true, readAt: new Date() }
    )

    // Real-time WebSocket emission
    emitToMerchant(String(merchantId), WS_EVENTS.MESSAGE_READ, {
      all: true,
      unreadCount: 0,
    })

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read.',
      unreadCount: 0,
    })
  } catch (error) {
    next(error)
  }
}

// Toggle or update labels on a message (e.g. Starred, Urgent, Follow-Up)
export async function toggleMessageLabel(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { label, action = 'toggle' } = req.body
    const merchantId = req.user!._id

    if (!label || typeof label !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'A valid label string is required.',
      })
    }

    const trimmedLabel = label.trim()
    const message = await Notification.findOne({ _id: id, merchantId })

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found.',
      })
    }

    const currentLabels = message.labels || []
    const exists = currentLabels.includes(trimmedLabel)

    if (action === 'add' || (action === 'toggle' && !exists)) {
      if (!exists) {
        message.labels.push(trimmedLabel)
      }
    } else if (action === 'remove' || (action === 'toggle' && exists)) {
      message.labels = currentLabels.filter((l) => l !== trimmedLabel)
    }

    await message.save()

    // Real-time WebSocket emission
    emitToMerchant(String(merchantId), WS_EVENTS.MESSAGE_LABELS_UPDATED, {
      id: message._id,
      labels: message.labels,
    })

    res.status(200).json({
      success: true,
      message: `Label "${trimmedLabel}" updated successfully.`,
      data: message,
    })
  } catch (error) {
    next(error)
  }
}

// Delete / Dismiss a message
export async function deleteMessage(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const merchantId = req.user!._id

    const deleted = await Notification.findOneAndDelete({ _id: id, merchantId })

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Message not found.',
      })
    }

    const unreadCount = await Notification.countDocuments({ merchantId, isRead: false })

    res.status(200).json({
      success: true,
      message: 'Message dismissed successfully.',
      unreadCount,
    })
  } catch (error) {
    next(error)
  }
}

// Create support ticket (Request Support > quick action)
export async function createSupportTicket(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.user!
    const {
      subject = 'General Inquiry',
      message = 'Merchant requested priority support',
      priority = 'high',
      labels = ['Support', 'Priority'],
    } = req.body

    const ticketId = `TICKET-${Date.now().toString().slice(-6)}`

    // Create system notification for merchant
    const notification = await Notification.create({
      merchantId: merchant._id,
      senderRole: 'system',
      senderName: 'PGX Support Bot',
      title: `Support Ticket Created: #${ticketId}`,
      content: `Your support request "${subject}" has been logged. Our fintech desk is reviewing your ticket and will reach out to ${merchant.businessEmail} shortly.`,
      type: 'support',
      priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'high',
      labels: Array.isArray(labels) ? labels : ['Support', 'Priority'],
      isRead: false,
      metadata: {
        ticketId,
        subject,
      },
    })

    const unreadCount = await Notification.countDocuments({
      merchantId: merchant._id,
      isRead: false,
    })

    // Real-time WebSocket emission to merchant
    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_NOTIFICATION, {
      notification,
      unreadCount,
    })

    // Notify admins of new support ticket
    emitToAdmins(WS_EVENTS.NEW_MESSAGE, {
      ticketId,
      notification,
      merchant: {
        id: merchant._id,
        email: merchant.businessEmail,
        fullName: merchant.fullName,
      },
    })

    res.status(201).json({
      success: true,
      message: 'Support ticket created successfully.',
      data: {
        ticketId,
        subject,
        message,
        status: 'open',
        priority,
        createdAt: new Date(),
      },
    })
  } catch (error) {
    next(error)
  }
}
