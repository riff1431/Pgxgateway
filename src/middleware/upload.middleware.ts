import multer from 'multer'
import path from 'node:path'

// In-memory buffer storage for direct Cloudinary streaming
const storage = multer.memoryStorage()

export const uploadDocs = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB maximum
  },
  fileFilter: (_req, file, cb) => {
    const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png']
    const ext = path.extname(file.originalname).toLowerCase()

    if (allowedExtensions.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('Invalid file type. Only PDF, JPG, JPEG, and PNG files are accepted.'))
    }
  },
})
