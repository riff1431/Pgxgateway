import mongoose, { Document, Schema, Types } from 'mongoose'

export type PaymentLinkStatus = 'active' | 'disabled' | 'completed'

export interface IPaymentLink extends Document {
  slug: string
  merchantId: Types.ObjectId | string
  merchantRefId: string
  resellerId: string
  title: string
  description?: string
  amount: number
  currency: string
  reusable: boolean
  status: PaymentLinkStatus
  totalPayments: number
  totalVolume: number
  lastPaidAt?: Date
  createdAt: Date
  updatedAt: Date
}

const PaymentLinkSchema = new Schema<IPaymentLink>(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },
    merchantRefId: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    resellerId: {
      type: String,
      default: 'admin_root',
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 140,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.5,
    },
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      trim: true,
    },
    reusable: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: ['active', 'disabled', 'completed'],
      default: 'active',
      index: true,
    },
    totalPayments: {
      type: Number,
      default: 0,
    },
    totalVolume: {
      type: Number,
      default: 0,
    },
    lastPaidAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
)

export const PaymentLink = mongoose.model<IPaymentLink>('PaymentLink', PaymentLinkSchema)
