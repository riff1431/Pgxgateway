import mongoose, { Document, Schema } from 'mongoose'

export interface ISystemConfig extends Document {
  siteName: string
  logoUrl?: string
  faviconUrl?: string
  supportEmail?: string
  supportPhone?: string
  supportTelegram?: string
  supportWhatsapp?: string
  updatedAt: Date
  createdAt: Date
}

const SystemConfigSchema = new Schema<ISystemConfig>(
  {
    siteName: {
      type: String,
      required: true,
      default: 'PGX Gateway',
      trim: true,
    },
    logoUrl: {
      type: String,
      default: '',
      trim: true,
    },
    faviconUrl: {
      type: String,
      default: '/favicon.svg',
      trim: true,
    },
    supportEmail: {
      type: String,
      default: 'support@pgxgateway.com',
      trim: true,
    },
    supportPhone: {
      type: String,
      default: '+1 (800) 749-4283',
      trim: true,
    },
    supportTelegram: {
      type: String,
      default: '@pgxsupport',
      trim: true,
    },
    supportWhatsapp: {
      type: String,
      default: '+1 (800) 749-4283',
      trim: true,
    },
  },
  {
    timestamps: true,
  }
)

export const SystemConfig = mongoose.model<ISystemConfig>('SystemConfig', SystemConfigSchema)
