import mongoose, { Document, Schema, Types } from 'mongoose'

export interface IReview extends Document {
  merchantId?: Types.ObjectId | string
  merchantRefId?: string
  authorName: string
  companyName: string
  country: string // 'US' | 'BD' | 'ES' | 'MX' | 'GB' | 'FR' etc.
  language: string // 'en' | 'bn' | 'es'
  rating: number // 1 to 5
  headline: string
  content: string
  avatarUrl?: string
  volumeProcessed?: string // e.g. '$150K+ Processed'
  status: 'pending' | 'approved' | 'rejected'
  isFeatured: boolean
  createdAt: Date
  updatedAt: Date
}

const ReviewSchema = new Schema<IReview>(
  {
    merchantId: {
      type: Schema.Types.Mixed,
      ref: 'Merchant',
      sparse: true,
      index: true,
    },
    merchantRefId: {
      type: String,
      trim: true,
      uppercase: true,
      sparse: true,
    },
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    country: {
      type: String,
      required: true,
      trim: true,
      default: 'US',
    },
    language: {
      type: String,
      required: true,
      trim: true,
      default: 'en',
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      default: 5,
    },
    headline: {
      type: String,
      trim: true,
      default: '',
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    avatarUrl: {
      type: String,
      trim: true,
      default: '',
    },
    volumeProcessed: {
      type: String,
      trim: true,
      default: '$50K+ Processed',
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved',
      index: true,
    },
    isFeatured: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
)

export const Review = mongoose.model<IReview>('Review', ReviewSchema)
