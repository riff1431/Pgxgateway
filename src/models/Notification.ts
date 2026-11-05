import mongoose, { Document, Schema } from 'mongoose'

export interface INotification extends Document {
  merchantId: mongoose.Types.ObjectId
  senderRole: 'merchant' | 'admin' | 'system'
  senderName?: string
  title: string
  content: string
  type: 'system' | 'offer' | 'document' | 'general' | 'compliance' | 'support'
  labels: string[]
  priority: 'low' | 'normal' | 'high' | 'urgent'
  isRead: boolean
  readAt?: Date | null
  replyTo?: mongoose.Types.ObjectId
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

const NotificationSchema = new Schema<INotification>(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },
    senderRole: {
      type: String,
      enum: ['merchant', 'admin', 'system'],
      default: 'system',
    },
    senderName: {
      type: String,
      trim: true,
      default: 'PGX Underwriting',
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['system', 'offer', 'document', 'general', 'compliance', 'support'],
      default: 'general',
    },
    labels: {
      type: [String],
      default: [],
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high', 'urgent'],
      default: 'normal',
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: 'Notification',
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
)

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema)
