import { v2 as cloudinary, UploadApiResponse } from 'cloudinary'
import { config } from './env.js'

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure: true,
})

export interface CloudinaryUploadResult {
  url: string
  publicId: string
  format: string
  bytes: number
}

export function uploadBufferToCloudinary(
  buffer: Buffer,
  originalFilename: string,
  folder = 'pgxgateway/documents'
): Promise<CloudinaryUploadResult> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'auto', // Handles PDF documents, PNG, JPG automatically
        filename_override: originalFilename,
        use_filename: true,
        unique_filename: true,
      },
      (error, result?: UploadApiResponse) => {
        if (error || !result) {
          return reject(error || new Error('Cloudinary upload returned empty response.'))
        }

        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          bytes: result.bytes,
        })
      }
    )

    uploadStream.end(buffer)
  })
}

export default cloudinary
