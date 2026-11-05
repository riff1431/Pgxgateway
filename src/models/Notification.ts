import mongoose, { Document, Schema } from 'mongoose'

export interface INotification extends Document {
  merchantId: mongoose.Types.ObjectId
  title: string
  content: string
  type: 'system' | 'offer' | 'document' | 'general'
  isRead: boolean
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
      enum: ['system', 'offer', 'document', 'general'],
      default: 'system',
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
)

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema)
