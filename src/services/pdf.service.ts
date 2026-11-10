import PDFDocument from 'pdfkit'
import { IInvoice } from '../models/Invoice.js'
import { IMerchant } from '../models/Merchant.js'

export async function generateInvoicePdfBuffer(
  invoice: IInvoice,
  merchant?: IMerchant | null,
  options?: {
    siteName?: string
    supportWhatsapp?: string
    supportEmail?: string
  }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 48,
        size: 'A4',
        info: {
          Title: `Tax Invoice ${invoice.invoiceNumber}`,
          Author: 'PGX Gateway Platform',
          Subject: 'Official Merchant Service Statement',
        },
      })

      const chunks: Buffer[] = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', (err) => reject(err))

      const siteName = options?.siteName || 'PGX GATEWAY'
      const supportWhatsapp = options?.supportWhatsapp || '+1 (437) 577-8785'
      const supportEmail = options?.supportEmail || 'finance@pgxgateway.com'

      const isMaintenance = invoice.invoiceType === 'monthly_maintenance'
      const isPaid = invoice.status === 'paid'
      const isOverdue = invoice.status === 'overdue'

      // ==========================================
      // 1. TOP BRAND ACCENT BAR
      // ==========================================
      doc.rect(0, 0, 595.28, 7).fill('#0A1128')
      doc.rect(0, 7, 595.28, 4).fill('#00D4E6')

      // ==========================================
      // 2. HEADER: BRANDING & INVOICE TITLE
      // ==========================================
      // Left: Platform Logo & Title (Strict bounded box width: 260 to prevent ANY collision)
      const brandTitle = (options?.siteName || 'PGX GATEWAY').replace(/ PLATFORM$/i, '')
      doc.fontSize(22).fillColor('#0A1128').font('Helvetica-Bold').text(brandTitle, 48, 28, {
        width: 260,
      })
      doc.fontSize(8).fillColor('#64748B').font('Helvetica-Bold').text(
        'ENTERPRISE PAYMENT ACQUIRING & SETTLEMENT',
        48,
        54,
        { width: 260 }
      )

      // Right: Document Title & Invoice Number (Strict bounded box at x: 318, width: 230)
      const invoiceTypeLabel = isMaintenance ? 'MAINTENANCE INVOICE' : 'SETTLEMENT STATEMENT'
      doc.fontSize(16).fillColor('#0F172A').font('Helvetica-Bold').text(invoiceTypeLabel, 318, 28, {
        align: 'right',
        width: 230,
      })
      doc.fontSize(10.5).fillColor('#0284C7').font('Helvetica-Bold').text(`#${invoice.invoiceNumber}`, 318, 48, {
        align: 'right',
        width: 230,
      })

      // Status Pill (Clean vector dot + bold text)
      const badgeW = 125
      const badgeH = 24
      const badgeX = 548 - badgeW
      const badgeY = 68

      const badgeFill = isPaid ? '#ECFDF5' : isOverdue ? '#FEF2F2' : '#F0F9FF'
      const badgeBorder = isPaid ? '#10B981' : isOverdue ? '#EF4444' : '#0284C7'
      const badgeDot = isPaid ? '#10B981' : isOverdue ? '#EF4444' : '#0284C7'
      const badgeText = isPaid ? 'PAID & SETTLED' : isOverdue ? 'OVERDUE' : 'PAYMENT DUE'
      const badgeTextColor = isPaid ? '#065F46' : isOverdue ? '#991B1B' : '#075985'

      doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 12).fillAndStroke(badgeFill, badgeBorder)
      // Vector dot (No unicode character)
      doc.circle(badgeX + 14, badgeY + 12, 3.5).fill(badgeDot)
      doc.fontSize(9).fillColor(badgeTextColor).font('Helvetica-Bold').text(
        badgeText,
        badgeX + 20,
        badgeY + 7.5,
        { width: badgeW - 24, align: 'center' }
      )

      // Divider line
      doc.moveTo(48, 104).lineTo(548, 104).strokeColor('#E2E8F0').lineWidth(1).stroke()

      // ==========================================
      // 3. HORIZONTAL 4-CHAMBER SUMMARY STRIP (Bigger & Roomier)
      // ==========================================
      const stripY = 116
      const stripW = 500
      const stripH = 54
      doc.roundedRect(48, stripY, stripW, stripH, 8).fillAndStroke('#F8FAFC', '#CBD5E1')

      const colW = stripW / 4

      // Box 1: Invoice Date
      doc.fontSize(8).fillColor('#64748B').font('Helvetica-Bold').text('INVOICE DATE', 48 + 12, stripY + 11)
      doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica-Bold').text(
        new Date(invoice.createdAt || invoice.billingCycleEnd).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        48 + 12,
        stripY + 28
      )

      // Box 2: Due Date
      doc.fontSize(8).fillColor('#64748B').font('Helvetica-Bold').text('PAYMENT DUE', 48 + colW + 10, stripY + 11)
      doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica-Bold').text(
        new Date(invoice.dueDate).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        48 + colW + 10,
        stripY + 28
      )

      // Box 3: Billing Cycle
      doc.fontSize(8).fillColor('#64748B').font('Helvetica-Bold').text('BILLING CYCLE', 48 + colW * 2 + 10, stripY + 11)
      const startStr = new Date(invoice.billingCycleStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const endStr = new Date(invoice.billingCycleEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      doc.fontSize(9.5).fillColor('#0F172A').font('Helvetica-Bold').text(
        `${startStr} – ${endStr}`,
        48 + colW * 2 + 10,
        stripY + 28
      )

      // Box 4: Settlement Channel
      doc.fontSize(8).fillColor('#64748B').font('Helvetica-Bold').text('SETTLEMENT CHANNEL', 48 + colW * 3 + 10, stripY + 11)
      const channelLabel = invoice.paymentMethod === 'stripe' ? 'Stripe Card Auto' : 'Bitcoin (BTC) Desk'
      doc.fontSize(10).fillColor('#0284C7').font('Helvetica-Bold').text(
        channelLabel,
        48 + colW * 3 + 10,
        stripY + 28
      )

      // Vertical dividers inside summary strip
      for (let i = 1; i <= 3; i++) {
        doc.moveTo(48 + colW * i, stripY + 8).lineTo(48 + colW * i, stripY + stripH - 8).strokeColor('#E2E8F0').lineWidth(0.8).stroke()
      }

      // ==========================================
      // 4. PARTIES: BILLED TO vs ISSUED BY (Bold, Large, Readable)
      // ==========================================
      const partiesY = 186

      // Left Column: Billed To (Merchant)
      doc.fontSize(9).fillColor('#94A3B8').font('Helvetica-Bold').text('BILLED TO (MERCHANT):', 48, partiesY)
      doc.fontSize(13).fillColor('#0F172A').font('Helvetica-Bold').text(
        merchant?.legalName || invoice.merchantName,
        48,
        partiesY + 16
      )
      doc.fontSize(10).fillColor('#334155').font('Helvetica')
      doc.text(`Merchant Ref ID: ${merchant?.refId || 'PGX_MERCHANT'}`, 48, partiesY + 34)
      doc.text(`Account Email: ${invoice.merchantEmail}`, 48, partiesY + 49)
      if (merchant?.industry) {
        doc.text(`Industry / Sector: ${merchant.industry}`, 48, partiesY + 64)
      }

      // Right Column: Issued By
      const issuerX = 310
      doc.fontSize(9).fillColor('#94A3B8').font('Helvetica-Bold').text('ISSUED BY (GATEWAY OPERATOR):', issuerX, partiesY)
      doc.fontSize(13).fillColor('#0F172A').font('Helvetica-Bold').text('PGX Gateway Inc.', issuerX, partiesY + 16)
      doc.fontSize(10).fillColor('#334155').font('Helvetica')
      doc.text(`Official Finance Desk: ${supportWhatsapp}`, issuerX, partiesY + 34)
      doc.text(`Billing & Support: ${supportEmail}`, issuerX, partiesY + 49)
      doc.text('Verification Portal: https://pgxgateway.com', issuerX, partiesY + 64)

      // ==========================================
      // 5. ITEMIZED CHARGES TABLE (Spacious, Clear, 11-12pt)
      // ==========================================
      const tableTop = 276
      const tableW = 500

      // Table Header Row
      doc.rect(48, tableTop, tableW, 28).fill('#0F172A')
      doc.fontSize(9).fillColor('#FFFFFF').font('Helvetica-Bold')
      doc.text('ITEM & SERVICE SPECIFICATION', 60, tableTop + 9)
      doc.text('BILLING BASIS', 290, tableTop + 9)
      doc.text('QTY', 405, tableTop + 9, { align: 'center', width: 30 })
      doc.text('AMOUNT (USD)', 455, tableTop + 9, { align: 'right', width: 83 })

      let rowY = tableTop + 28

      if (isMaintenance) {
        // Line Item 1: Monthly Maintenance Base Fee
        const baseAmount = invoice.payableAmount - (invoice.surchargeAmount || 0)
        doc.rect(48, rowY, tableW, 48).fill('#FFFFFF')
        doc.fontSize(11).fillColor('#0F172A').font('Helvetica-Bold').text(
          'Monthly Platform Maintenance & Node SLA',
          60,
          rowY + 10
        )
        doc.fontSize(9).fillColor('#64748B').font('Helvetica').text(
          'Continuous gateway uptime, security patches, 3DS 2.0 liability shift, & 99.99% uptime guarantee',
          60,
          rowY + 27
        )

        doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica').text('$99.00 / mo', 290, rowY + 16)
        doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica').text('1', 405, rowY + 16, { align: 'center', width: 30 })
        doc.fontSize(11.5).fillColor('#0F172A').font('Helvetica-Bold').text(
          `$${baseAmount.toFixed(2)}`,
          455,
          rowY + 16,
          { align: 'right', width: 83 }
        )

        doc.moveTo(48, rowY + 48).lineTo(548, rowY + 48).strokeColor('#E2E8F0').lineWidth(0.5).stroke()
        rowY += 48

        // Line Item 2: 3% Surcharge (if present)
        if (invoice.surchargeAmount && invoice.surchargeAmount > 0) {
          doc.rect(48, rowY, tableW, 46).fill('#F8FAFC')
          doc.fontSize(11).fillColor('#0F172A').font('Helvetica-Bold').text(
            'Stripe Card Processing Surcharge (3%)',
            60,
            rowY + 10
          )
          doc.fontSize(9).fillColor('#64748B').font('Helvetica').text(
            'Standard 3% credit/debit card gateway interchange pass-through fee',
            60,
            rowY + 26
          )

          doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica').text('3.0%', 290, rowY + 15)
          doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica').text('1', 405, rowY + 15, { align: 'center', width: 30 })
          doc.fontSize(11.5).fillColor('#0F172A').font('Helvetica-Bold').text(
            `+$${invoice.surchargeAmount.toFixed(2)}`,
            455,
            rowY + 15,
            { align: 'right', width: 83 }
          )

          doc.moveTo(48, rowY + 46).lineTo(548, rowY + 46).strokeColor('#E2E8F0').lineWidth(0.5).stroke()
          rowY += 46
        }
      } else {
        // Line Item: Weekly Volume
        doc.rect(48, rowY, tableW, 48).fill('#FFFFFF')
        doc.fontSize(11).fillColor('#0F172A').font('Helvetica-Bold').text(
          'Weekly Platform Processing Fee',
          60,
          rowY + 10
        )
        doc.fontSize(9).fillColor('#64748B').font('Helvetica').text(
          `Aggregated fee on verified transaction volume of $${(invoice.eligibleVolume || 0).toFixed(2)}`,
          60,
          rowY + 27
        )

        doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica').text(`${invoice.feeRate || 9.0}%`, 290, rowY + 16)
        doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica').text('1', 405, rowY + 16, { align: 'center', width: 30 })
        doc.fontSize(11.5).fillColor('#0F172A').font('Helvetica-Bold').text(
          `$${invoice.payableAmount.toFixed(2)}`,
          455,
          rowY + 16,
          { align: 'right', width: 83 }
        )

        doc.moveTo(48, rowY + 48).lineTo(548, rowY + 48).strokeColor('#E2E8F0').lineWidth(0.5).stroke()
        rowY += 48
      }

      // Outer table border
      doc.rect(48, tableTop, tableW, rowY - tableTop).strokeColor('#CBD5E1').lineWidth(0.8).stroke()

      // ==========================================
      // 6. TOTALS & SETTLEMENT RECONCILIATION
      // ==========================================
      const blockY = rowY + 20

      // Left Column: Settlement & Audit Trail Box
      const auditW = 265
      const auditH = 120
      doc.roundedRect(48, blockY, auditW, auditH, 8).fillAndStroke('#F8FAFC', '#CBD5E1')

      doc.fontSize(9).fillColor('#0F172A').font('Helvetica-Bold').text('SETTLEMENT & AUDIT TRAIL', 60, blockY + 13)

      doc.fontSize(9.5).fillColor('#64748B').font('Helvetica')
      doc.text('Payment Status:', 60, blockY + 32)
      doc.fontSize(9.5).fillColor(isPaid ? '#10B981' : '#EF4444').font('Helvetica-Bold').text(
        isPaid ? 'Settled & Reconciled' : 'Pending Settlement',
        160,
        blockY + 32
      )

      doc.fontSize(9.5).fillColor('#64748B').font('Helvetica')
      doc.text('Settlement Rail:', 60, blockY + 49)
      doc.fontSize(9.5).fillColor('#0F172A').font('Helvetica').text(
        invoice.paymentMethod === 'stripe' ? 'Stripe Card Auto-Debit' : 'Bitcoin (BTC) Desk',
        160,
        blockY + 49
      )

      if (invoice.stripeSessionId) {
        doc.fontSize(9.5).fillColor('#64748B').font('Helvetica')
        doc.text('Gateway PI Ref:', 60, blockY + 66)
        doc.fontSize(9).fillColor('#0F172A').font('Helvetica').text(
          invoice.stripeSessionId.slice(0, 22),
          160,
          blockY + 66
        )
      }

      doc.fontSize(9.5).fillColor('#64748B').font('Helvetica')
      doc.text('Settlement Date:', 60, blockY + 83)
      doc.fontSize(9).fillColor('#0F172A').font('Helvetica').text(
        invoice.paidAt ? new Date(invoice.paidAt).toUTCString().slice(0, 22) : 'Awaiting Payment',
        160,
        blockY + 83
      )

      doc.fontSize(8).fillColor('#94A3B8').font('Helvetica').text(
        'Direct settlement available via Stripe or Bitcoin (BTC) on WhatsApp Desk.',
        60,
        blockY + 102
      )

      // Right Column: Totals Calculation Card
      const totalsX = 330
      const totalsW = 218
      const baseSubtotal = isMaintenance
        ? invoice.payableAmount - (invoice.surchargeAmount || 0)
        : invoice.payableAmount

      doc.fontSize(10).fillColor('#64748B').font('Helvetica').text('Base Subtotal:', totalsX, blockY + 6)
      doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica-Bold').text(
        `$${baseSubtotal.toFixed(2)} USD`,
        totalsX,
        blockY + 6,
        { align: 'right', width: totalsW }
      )

      if (invoice.surchargeAmount && invoice.surchargeAmount > 0) {
        doc.fontSize(10).fillColor('#64748B').font('Helvetica').text('Card Processing (3%):', totalsX, blockY + 25)
        doc.fontSize(10.5).fillColor('#0F172A').font('Helvetica-Bold').text(
          `+$${invoice.surchargeAmount.toFixed(2)} USD`,
          totalsX,
          blockY + 25,
          { align: 'right', width: totalsW }
        )
      }

      doc.moveTo(totalsX, blockY + 45).lineTo(totalsX + totalsW, blockY + 45).strokeColor('#CBD5E1').lineWidth(0.8).stroke()

      // High-contrast Grand Total Block (Bigger font: 15pt)
      const grandTotalY = blockY + 54
      doc.roundedRect(totalsX, grandTotalY, totalsW, 40, 6).fill('#0A1128')
      doc.fontSize(10.5).fillColor('#FFFFFF').font('Helvetica-Bold').text('TOTAL AMOUNT:', totalsX + 12, grandTotalY + 15)
      doc.fontSize(15).fillColor('#00F0FF').font('Helvetica-Bold').text(
        `$${invoice.payableAmount.toFixed(2)} USD`,
        totalsX,
        grandTotalY + 12,
        { align: 'right', width: totalsW - 12 }
      )

      // Payment summary
      doc.fontSize(10).fillColor('#10B981').font('Helvetica-Bold').text(
        `Amount Paid: ${isPaid ? `$${invoice.payableAmount.toFixed(2)}` : '$0.00'}`,
        totalsX,
        grandTotalY + 50
      )
      doc.fontSize(10).fillColor(isPaid ? '#64748B' : '#EF4444').font('Helvetica-Bold').text(
        `Balance Due: ${isPaid ? '$0.00' : `$${invoice.payableAmount.toFixed(2)}`}`,
        totalsX,
        grandTotalY + 50,
        { align: 'right', width: totalsW }
      )

      // ==========================================
      // 7. ENTERPRISE GUARANTEES & NOTICE STRIP (Clear 9pt fonts)
      // ==========================================
      const noticeY = 535
      doc.roundedRect(48, noticeY, 500, 76, 8).fillAndStroke('#F8FAFC', '#CBD5E1')

      const featColW = 500 / 3

      // Col 1
      doc.fontSize(9.5).fillColor('#0A1128').font('Helvetica-Bold').text('BANK-GRADE SECURITY', 48 + 14, noticeY + 14)
      doc.fontSize(8.5).fillColor('#475569').font('Helvetica').text(
        'Protected by 3DS 2.0 liability shift and 256-bit SSL encryption.',
        48 + 14,
        noticeY + 30,
        { width: featColW - 24, lineGap: 2 }
      )

      // Col 2
      doc.fontSize(9.5).fillColor('#0A1128').font('Helvetica-Bold').text('99.99% UPTIME SLA', 48 + featColW + 10, noticeY + 14)
      doc.fontSize(8.5).fillColor('#475569').font('Helvetica').text(
        'Continuous server monitoring, automated node updates, and failover.',
        48 + featColW + 10,
        noticeY + 30,
        { width: featColW - 24, lineGap: 2 }
      )

      // Col 3
      doc.fontSize(9.5).fillColor('#0A1128').font('Helvetica-Bold').text('DIRECT DESK ASSISTANCE', 48 + featColW * 2 + 10, noticeY + 14)
      doc.fontSize(8.5).fillColor('#475569').font('Helvetica').text(
        `Instant support on WhatsApp: ${supportWhatsapp}`,
        48 + featColW * 2 + 10,
        noticeY + 30,
        { width: featColW - 24, lineGap: 2 }
      )

      // Vertical dividers inside feature strip
      doc.moveTo(48 + featColW, noticeY + 10).lineTo(48 + featColW, noticeY + 66).strokeColor('#E2E8F0').lineWidth(0.8).stroke()
      doc.moveTo(48 + featColW * 2, noticeY + 10).lineTo(48 + featColW * 2, noticeY + 66).strokeColor('#E2E8F0').lineWidth(0.8).stroke()

      // ==========================================
      // 8. LEGAL & VERIFICATION FOOTER
      // ==========================================
      const footerY = 745
      doc.moveTo(48, footerY).lineTo(548, footerY).strokeColor('#CBD5E1').lineWidth(0.8).stroke()

      doc.fontSize(8.5).fillColor('#64748B').font('Helvetica').text(
        'This is an official system-generated tax statement issued by PGX Gateway Inc. in association with PlayGroundX Network.',
        48,
        footerY + 12,
        { align: 'center', width: 500 }
      )
      doc.fontSize(8).fillColor('#94A3B8').text(
        `Document Ref: ${invoice.invoiceNumber} • Generated on ${new Date().toISOString()} • Confidential & Verifiable`,
        48,
        footerY + 26,
        { align: 'center', width: 500 }
      )

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
