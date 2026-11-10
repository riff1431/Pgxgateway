import fs from 'fs'
import path from 'path'
import { generateInvoicePdfBuffer } from '../services/pdf.service.js'

async function generateSample() {
  const sampleInvoice: any = {
    invoiceNumber: 'INV-MAINT-20261110-8F92A1',
    merchantName: 'Pulse Core Technologies FZCO',
    merchantEmail: 'billing@pulsecore.tech',
    resellerId: 'admin_root',
    billingCycleStart: new Date('2026-11-10T00:00:00Z'),
    billingCycleEnd: new Date('2026-12-10T00:00:00Z'),
    eligibleVolume: 0,
    feeRate: 0,
    payableAmount: 101.97,
    surchargeAmount: 2.97,
    invoiceType: 'monthly_maintenance',
    status: 'paid',
    dueDate: new Date('2026-11-10T00:00:00Z'),
    paidAt: new Date('2026-11-10T09:30:00Z'),
    paymentMethod: 'stripe',
    stripeSessionId: 'pi_live_1Ua9gmJusBCApDC2K5Iv',
    createdAt: new Date('2026-11-10T09:30:00Z'),
  }

  const sampleMerchant: any = {
    fullName: 'Pulse Core Technologies FZCO',
    legalName: 'Pulse Core Technologies FZCO',
    businessEmail: 'billing@pulsecore.tech',
    refId: 'PGX_REF_57F349',
    industry: 'SaaS & Digital Services',
  }

  console.log('Generating PDF buffer...')
  const pdfBuffer = await generateInvoicePdfBuffer(sampleInvoice, sampleMerchant, {
    siteName: 'PGX GATEWAY PLATFORM',
    supportWhatsapp: '+1 (437) 577-8785',
    supportEmail: 'finance@pgxgateway.com',
  })

  // 1. Save directly to Desktop as requested by user
  const desktopPath = 'C:\\Users\\Tanvir\\Desktop\\PGX_Sample_Invoice_INV-MAINT-20261110.pdf'
  fs.writeFileSync(desktopPath, pdfBuffer)
  console.log(`✔ Sample PDF Invoice saved to Desktop: ${desktopPath}`)

  // 2. Also save to Artifact directory for persistent record
  const artifactDir = 'C:\\Users\\Tanvir\\.gemini\\antigravity\\brain\\39df7bfb-88f8-43d3-801b-a02ba4077a7e'
  const artifactPath = path.join(artifactDir, 'PGX_Sample_Invoice_INV-MAINT-20261110.pdf')
  fs.writeFileSync(artifactPath, pdfBuffer)
  console.log(`✔ Sample PDF Invoice saved to Artifacts: ${artifactPath}`)

  console.log(`File size: ${(pdfBuffer.length / 1024).toFixed(2)} KB`)
}

generateSample().catch(console.error)
