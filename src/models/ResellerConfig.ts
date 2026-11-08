import mongoose, { Document, Schema } from 'mongoose'

export interface IResellerConfig extends Document {
  resellerId: string
  stripe: {
    publishableKey: string
    secretKey: string
    webhookSecret: string
    isConfigured: boolean
    mode: 'test' | 'live'
  }
  feeSettings: {
    basePlatformFee: number // Fixed 9.0%
    merchantFeeRate: number // Configured by reseller, must be >= 9.0%
  }
  prepaidBalance: number
  totalVolumeProcessed: number
  totalPlatformFeesEarned: number
  totalResellerProfit: number
  payoutTerms?: string
  createdAt: Date
  updatedAt: Date
}

const ResellerConfigSchema = new Schema<IResellerConfig>(
  {
    resellerId: {
      type: String,
      required: true,
      unique: true,
      default: 'admin_root',
      index: true,
    },
    stripe: {
      publishableKey: { type: String, default: '', trim: true },
      secretKey: { type: String, default: '', trim: true },
      webhookSecret: { type: String, default: '', trim: true },
      isConfigured: { type: Boolean, default: false },
      mode: { type: String, enum: ['test', 'live'], default: 'test' },
    },
    feeSettings: {
      basePlatformFee: { type: Number, default: 9.0, min: 0 },
      merchantFeeRate: { type: Number, default: 12.0, min: 9.0 },
    },
    prepaidBalance: { type: Number, default: 0 },
    totalVolumeProcessed: { type: Number, default: 0 },
    totalPlatformFeesEarned: { type: Number, default: 0 },
    totalResellerProfit: { type: Number, default: 0 },
    payoutTerms: { type: String, default: 'Weekly Wire / Crypto Transfer' },
  },
  {
    timestamps: true,
  }
)

export const ResellerConfig = mongoose.model<IResellerConfig>('ResellerConfig', ResellerConfigSchema)
