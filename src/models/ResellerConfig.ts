import mongoose, { Document, Schema } from 'mongoose'

export interface IResellerConfig extends Document {
  resellerId: string
  name?: string
  email?: string
  passwordHash?: string
  status: 'active' | 'suspended'
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
  createdBy?: string
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
    name: {
      type: String,
      trim: true,
      default: 'Primary Root Gateway',
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
      sparse: true,
    },
    passwordHash: {
      type: String,
      select: false, // Hidden from queries by default for security
    },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
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
    createdBy: { type: String, default: 'super_admin' },
  },
  {
    timestamps: true,
  }
)

export const ResellerConfig = mongoose.model<IResellerConfig>('ResellerConfig', ResellerConfigSchema)
