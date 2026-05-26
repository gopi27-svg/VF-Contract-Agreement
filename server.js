const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// ── Date formatting ────────────────────────────────────────
function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  const day = d.getUTCDate();
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const suffix = (day%10===1&&day!==11)?'st':(day%10===2&&day!==12)?'nd':(day%10===3&&day!==13)?'rd':'th';
  return `${String(day).padStart(2,'0')}${suffix} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ── Log to Google Sheet via Apps Script ────────────────────
function logToSheet(row, agreementType) {
  return new Promise((resolve) => {
    try {
      const scriptUrl = process.env.APPS_SCRIPT_URL;
      if (!scriptUrl) return resolve();

      const rowEncoded = encodeURIComponent(JSON.stringify(row));
      const fullUrl = `${scriptUrl}?agreementType=${agreementType}&rowData=${rowEncoded}`;
      const urlObj = new URL(fullUrl);

      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET'
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log('Sheet log response:', data);
          resolve();
        });
      });
      req.on('error', err => {
        console.error('Sheet log error:', err.message);
        resolve();
      });
      req.end();
    } catch(err) {
      console.error('logToSheet error:', err.message);
      resolve();
    }
  });
}

// ── Build PDF HTML (contract content) ─────────────────────
function buildPdfHtml(row) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; padding: 40px; font-size: 13px; color: #000; }
    h2 { text-align: center; margin-bottom: 30px; }
    .field { margin-bottom: 10px; }
    .label { font-weight: bold; }
    .signature { margin-top: 60px; }
  </style>
</head>
<body>
  <h2>Visiting Faculty Contract Agreement</h2>
  <div class="field"><span class="label">Doc Ref:</span> ${row['Doc Ref'] || ''}</div>
  <div class="field"><span class="label">Name:</span> ${row['Name'] || ''}</div>
  <div class="field"><span class="label">Address:</span> ${row['Address'] || ''}</div>
  <div class="field"><span class="label">Start Date:</span> ${formatDate(row['Start_Date'])}</div>
  <div class="field"><span class="label">End Date:</span> ${formatDate(row['End_Date'])}</div>
  <div class="field"><span class="label">Course:</span> ${row['Course'] || ''}</div>
  <div class="field"><span class="label">Live Class:</span> ${row['Live_Class'] || ''}</div>
  <div class="field"><span class="label">TLEP:</span> ${row['TLEP'] || ''}</div>
  <div class="field"><span class="label">Pre-recording:</span> ${row['Pre-recording'] || ''}</div>
  <div class="field"><span class="label">CA Evaluation:</span> ${row['CA Evaluation'] || ''}</div>
  <div class="field"><span class="label">QB:</span> ${row['QB'] || ''}</div>
  <div class="signature">
    <p>Signature: ___________________________</p>
    <p>Date: ___________________________</p>
  </div>
</body>
</html>`;
}

// ── Build Email Body (original body restored) ──────────────
function buildEmailHtml() {
  return `<p>Dear Faculty,</p>
<p>We are excited to welcome you as a visiting faculty in USDC Projects India Pvt Ltd. Your expertise will be invaluable to our students, and we're eager to get started.</p>
<p><strong>Onboarding Steps</strong></p>
<p><strong>Review and Sign Document:</strong> Attached to this email is an important document</p>
<ul>
  <li><strong>Visiting Faculty Contract:</strong> This outlines the terms and conditions of the work.</li>
</ul>
<p>Please review, sign, and return the document.</p>
<p>To ensure smoother and more efficient payment transactions in the future, we are requesting you fill out a brief Google Form. Your input will help us streamline our processes and enhance our service.</p>
<p>Please take a moment to complete the form by clicking the link below:</p>
<p><a href="https://forms.gle/jNJPPgYPQuAkibGx6" target="_blank">Visiting Faculty Registration Form - https://forms.gle/jNJPPgYPQuAkibGx6</a></p>`;
}

// ── Health check ───────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, app: 'VF Mail Backend' }));

// ── Main POST endpoint ─────────────────────────────────────
app.post('/send', async (req, res) => {
  try {
    const { agreementType, rows } = req.body;
    if (!rows || !rows.length) return res.status(400).json({ ok: false, message: 'No rows' });

    const transporter = nodemailer.createTransport({
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.HR_EMAIL,
        pass: process.env.HR_PASSWORD
      }
    });

    let sentCount = 0;

    for (const row of rows) {
      const toEmail = (row['Email_Id'] || '').trim();
      if (!toEmail) continue;

      const excelCC = (row['Email'] || '').trim();
      const fixedCC = process.env.CC_EMAILS || '';
      const finalCC = [excelCC, fixedCC].filter(Boolean).join(',');

      // Generate PDF using html-to-pdf approach
      const pdfName = `VF_${(row['Doc Ref'] || 'Doc')}_${(row['Name'] || 'Name')}.pdf`.replace(/[\\/:*?"<>|]/g, '_');

      // Convert HTML to PDF buffer using a simple approach
      let pdfBuffer = null;
      try {
        pdfBuffer = await generatePdf(buildPdfHtml(row));
      } catch (pdfErr) {
        console.error('PDF generation error:', pdfErr.message);
      }

      const mailOptions = {
        from: `"HR USDC" <${process.env.HR_EMAIL}>`,
        to: toEmail,
        cc: finalCC,
        replyTo: process.env.HR_EMAIL,
        subject: agreementType === 'international'
          ? 'Welcome to the Team! International Academic Team – Onboarding Document'
          : 'Welcome to the Team! Visiting Faculty Onboarding Document',
        html: buildEmailHtml()
      };

      // Attach PDF if generated successfully
      if (pdfBuffer) {
        mailOptions.attachments = [{
          filename: pdfName,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }];
      }

      await transporter.sendMail(mailOptions);

      // Log to Google Sheet
      await logToSheet(row, agreementType || 'normal');

      sentCount++;
    }

    res.json({ ok: true, sentCount });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── PDF Generation using puppeteer ────────────────────────
async function generatePdf(htmlContent) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({
    format: 'A4',
    margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' }
  });
  await browser.close();
  return pdfBuffer;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));