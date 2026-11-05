import { Request, Response } from 'express'

export function notFound(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    status: 404,
    message: `Cannot ${req.method} ${req.originalUrl} - Route Not Found`,
  })
}
