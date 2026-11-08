import mongoose, { Document, Schema } from 'mongoose'

export interface ISetupMessage extends Document {
  merchantId: mongoose.Types.ObjectId
  senderRole: 'merchant' | 'super_admin'
  senderName: string
  message: string
  read: boolean
  createdAt: Date
  updatedAt: Date
}

const SetupMessageSchema = new Schema<ISetupMessage>(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },
    senderRole: {
      type: String,
      enum: ['merchant', 'super_admin'],
      required: true,
    },
    senderName: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    read: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
)

export const SetupMessage = mongoose.model<ISetupMessage>('SetupMessage', SetupMessageSchema)
