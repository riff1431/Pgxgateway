import mongoose, { Document, Schema, Types } from 'mongoose'

export interface ITransaction extends Document {
  transactionId: string
  resellerId?: Types.ObjectId | string
  merchantId: Types.ObjectId | string
  merchantRefId: string
  stripePaymentIntentId?: string
  stripeSessionId?: string
  stripeEventId?: string // Idempotency protection for webhooks
  currency: string
  grossAmount: number
  grossCents: number
  platformFeeRate: number // Hardwired 9.0%
  platformFeeAmount: number
  platformFeeCents: number
  resellerFeeRate: number // e.g. 12.0%
  resellerFeeAmount: number
  resellerFeeCents: number
  resellerProfitAmount: number // Spread (resellerFee - platformFee)
  resellerProfitCents: number
  merchantNetAmount: number // Net owed to sub-merchant
  merchantNetCents: number
  tier?: 1 | 2
  settlementHoldDays?: number
  settlementEligibleAt?: Date
  settlementStatus?: 'on_hold' | 'available' | 'paid_out'
  rollingReserveRate?: number
  rollingReserveAmount?: number
  rollingReserveReleaseAt?: Date
  rollingReserveStatus?: 'locked' | 'released'
  status: 'pending' | 'succeeded' | 'failed' | 'refunded'
  customerEmail?: string
  customerName?: string
  orderId?: string
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

const TransactionSchema = new Schema<ITransaction>(
  {
    transactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    resellerId: {
      type: Schema.Types.Mixed,
      default: 'admin_root',
      index: true,
    },
    merchantId: {
      type: Schema.Types.Mixed,
      required: true,
      index: true,
    },
    merchantRefId: {
      type: String,
      required: true,
      index: true,
      uppercase: true,
      trim: true,
    },
    stripePaymentIntentId: {
      type: String,
      sparse: true,
      index: true,
    },
    stripeSessionId: {
      type: String,
      sparse: true,
      index: true,
    },
    stripeEventId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      trim: true,
    },
    grossAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    grossCents: {
      type: Number,
      required: true,
      min: 0,
    },
    platformFeeRate: {
      type: Number,
      required: true,
      default: 9.0, // Fixed 9%
    },
    platformFeeAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    platformFeeCents: {
      type: Number,
      required: true,
      default: 0,
    },
    resellerFeeRate: {
      type: Number,
      required: true,
      default: 12.0,
    },
    resellerFeeAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    resellerFeeCents: {
      type: Number,
      required: true,
      default: 0,
    },
    resellerProfitAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    resellerProfitCents: {
      type: Number,
      required: true,
      default: 0,
    },
    merchantNetAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    merchantNetCents: {
      type: Number,
      required: true,
      default: 0,
    },
    tier: {
      type: Number,
      enum: [1, 2],
      default: 1,
    },
    settlementHoldDays: {
      type: Number,
      default: 14,
    },
    settlementEligibleAt: {
      type: Date,
    },
    settlementStatus: {
      type: String,
      enum: ['on_hold', 'available', 'paid_out'],
      default: 'on_hold',
      index: true,
    },
    rollingReserveRate: {
      type: Number,
      default: 10,
    },
    rollingReserveAmount: {
      type: Number,
      default: 0,
    },
    rollingReserveReleaseAt: {
      type: Date,
    },
    rollingReserveStatus: {
      type: String,
      enum: ['locked', 'released'],
      default: 'locked',
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },
    customerEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    customerName: {
      type: String,
      trim: true,
    },
    orderId: {
      type: String,
      trim: true,
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

export const Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema)
