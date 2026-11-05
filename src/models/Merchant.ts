import mongoose, { Document, Schema } from 'mongoose'
import bcrypt from 'bcryptjs'

export interface IMerchant extends Document {
  // Account Information (Step 1)
  fullName: string
  businessEmail: string
  phone: string
  whatsapp?: string
  telegram?: string
  password?: string

  // Business & Processing Information (Step 2)
  legalName?: string
  industry?: string
  website?: string
  yearsInBusiness?: string
  currentProcessor?: string
  monthlyVolume?: string
  avgTransaction?: string
  chargebackRate?: string
  switchReason?: string

  // Verification & Documents (Step 3)
  businessRegDoc?: {
    name: string
    url?: string
    path?: string
    size?: string
    uploadedAt: Date
  }
  directorIdDoc?: {
    name: string
    url?: string
    path?: string
    size?: string
    uploadedAt: Date
  }
  processingStatementDoc?: {
    name: string
    url?: string
    path?: string
    size?: string
    uploadedAt: Date
  }
  agreedToTerms: boolean

  // Status & Workflow
  currentStep: number
  applicationStatus: 'draft' | 'under_review' | 'approved' | 'rejected'

  // Processing Offer
  offer?: {
    rate: string
    volume: string
    settlement: string
    reserve: string
    isAvailable: boolean
    accepted?: boolean
    acceptedAt?: Date
  }

  createdAt: Date
  updatedAt: Date

  comparePassword(candidatePassword: string): Promise<boolean>
}

const MerchantSchema = new Schema<IMerchant>(
  {
    // Step 1
    fullName: { type: String, required: true, trim: true },
    businessEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    whatsapp: { type: String, trim: true },
    telegram: { type: String, trim: true },
    password: { type: String, select: false },

    // Step 2
    legalName: { type: String, trim: true },
    industry: { type: String, trim: true },
    website: { type: String, trim: true },
    yearsInBusiness: { type: String, trim: true },
    currentProcessor: { type: String, trim: true },
    monthlyVolume: { type: String, trim: true },
    avgTransaction: { type: String, trim: true },
    chargebackRate: { type: String, trim: true },
    switchReason: { type: String, trim: true },

    // Step 3
    businessRegDoc: {
      name: String,
      url: String,
      path: String,
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    directorIdDoc: {
      name: String,
      url: String,
      path: String,
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    processingStatementDoc: {
      name: String,
      url: String,
      path: String,
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    agreedToTerms: { type: Boolean, default: false },

    // Workflow
    currentStep: { type: Number, default: 1, min: 1, max: 3 },
    applicationStatus: {
      type: String,
      enum: ['draft', 'under_review', 'approved', 'rejected'],
      default: 'under_review',
    },

    // Processing Offer details
    offer: {
      rate: { type: String, default: '' },
      volume: { type: String, default: '' },
      settlement: { type: String, default: '' },
      reserve: { type: String, default: '' },
      isAvailable: { type: Boolean, default: false },
      accepted: { type: Boolean, default: false },
      acceptedAt: { type: Date },
    },
  },
  {
    timestamps: true,
  }
)

// Pre-save hook: Hash password before saving if modified
MerchantSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) {
    return next()
  }

  try {
    const salt = await bcrypt.genSalt(10)
    this.password = await bcrypt.hash(this.password, salt)
    next()
  } catch (err) {
    next(err as Error)
  }
})

// Compare password method
MerchantSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  if (!this.password) return false
  return bcrypt.compare(candidatePassword, this.password)
}

export const Merchant = mongoose.model<IMerchant>('Merchant', MerchantSchema)
