import mongoose, { Document, Schema } from 'mongoose'

export type InvoiceStatus =
  | 'draft'
  | 'issued'
  | 'pending'
  | 'under_review'
  | 'paid'
  | 'overdue'
  | 'disputed'
  | 'adjusted'

export interface IInvoice extends Document {
  invoiceNumber: string
  merchantId: mongoose.Types.ObjectId
  merchantName: string
  merchantEmail: string
  resellerId: string
  billingCycleStart: Date
  billingCycleEnd: Date
  eligibleVolume: number // Total transaction volume for the week
  feeRate: number // Default 9.0%
  payableAmount: number // eligibleVolume * (feeRate / 100)
  resellerShareRate: number // e.g., 2.0%
  resellerShareAmount: number // eligibleVolume * (resellerShareRate / 100)
  platformRetainedAmount: number // payableAmount - resellerShareAmount
  invoiceType?: 'weekly_volume' | 'monthly_maintenance'
  surchargeAmount?: number
  status: InvoiceStatus
  dueDate: Date
  paidAt?: Date
  paymentMethod?: 'stripe' | 'bank_transfer'
  proofDocUrl?: string
  stripeSessionId?: string
  adminNotes?: string
  createdAt: Date
  updatedAt: Date
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },
    merchantName: { type: String, required: true, trim: true },
    merchantEmail: { type: String, required: true, trim: true, lowercase: true },
    resellerId: { type: String, default: 'admin_root', index: true },
    billingCycleStart: { type: Date, required: true },
    billingCycleEnd: { type: Date, required: true },
    eligibleVolume: { type: Number, required: true, default: 0 },
    feeRate: { type: Number, required: true, default: 9.0 },
    payableAmount: { type: Number, required: true, default: 0 },
    resellerShareRate: { type: Number, default: 2.0 },
    resellerShareAmount: { type: Number, default: 0 },
    platformRetainedAmount: { type: Number, default: 0 },
    invoiceType: {
      type: String,
      enum: ['weekly_volume', 'monthly_maintenance'],
      default: 'weekly_volume',
      index: true,
    },
    surchargeAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['draft', 'issued', 'pending', 'under_review', 'paid', 'overdue', 'disputed', 'adjusted'],
      default: 'issued',
      index: true,
    },
    dueDate: { type: Date, required: true },
    paidAt: { type: Date },
    paymentMethod: { type: String, enum: ['stripe', 'bank_transfer'] },
    proofDocUrl: { type: String, trim: true, default: '' },
    stripeSessionId: { type: String, trim: true },
    adminNotes: { type: String, trim: true, default: '' },
  },
  {
    timestamps: true,
  }
)

export const Invoice = mongoose.model<IInvoice>('Invoice', InvoiceSchema)
