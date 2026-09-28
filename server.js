const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Ask Apps Script to fill the Google Doc template, make the PDF and log to Sheet ──
// Returns { pdfBuffer, pdfName, pdfUrl } or throws with the reason.
async function getPdfFromAppsScript(row, agreementType) {
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  if (!scriptUrl) throw new Error('APPS_SCRIPT_URL is not set on Render');

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {           // one retry
    try {
      const res = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ agreementType, row }),
        redirect: 'follow'
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('Apps Script did not return JSON (check deployment access = Anyone): ' + text.slice(0, 150)); }

      if (!data.ok || !data.pdfBase64) throw new Error(data.message || 'No PDF returned');
      if (data.logError) console.error('Sheet log warning:', data.logError);
      console.log('PDF ready:', data.pdfUrl);
      return {
        pdfBuffer: Buffer.from(data.pdfBase64, 'base64'),
        pdfName: data.pdfName,
        pdfUrl: data.pdfUrl
      };
    } catch (err) {
      lastErr = err;
      console.error(`Apps Script attempt ${attempt} failed:`, err.message);
    }
  }
  throw lastErr;
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
      auth: { user: process.env.HR_EMAIL, pass: process.env.HR_PASSWORD }
    });

    let sentCount = 0;
    const failed = [];

    for (const row of rows) {
      const toEmail = String(row['Email_Id'] || '').trim();
      const who = row['Name'] || toEmail || row['Doc Ref'] || 'Unknown';
      if (!toEmail) { failed.push({ name: who, reason: 'Email_Id missing' }); continue; }

      try {
        // 1. Get the filled contract PDF (also logs the row in Google Sheet)
        const pdf = await getPdfFromAppsScript(row, agreementType || 'normal');

        // 2. Send mail WITH the PDF (never without it)
        const excelCC = String(row['Email'] || '').trim();
        const fixedCC = process.env.CC_EMAILS || '';
        const finalCC = [excelCC, fixedCC].filter(Boolean).join(',');

        await transporter.sendMail({
          from: `"HR USDC" <${process.env.HR_EMAIL}>`,
          to: toEmail,
          cc: finalCC,
          replyTo: process.env.HR_EMAIL,
          subject: agreementType === 'international'
            ? 'Welcome to the Team! International Academic Team – Onboarding Document'
            : 'Welcome to the Team! Visiting Faculty Onboarding Document',
          html: buildEmailHtml(),
          attachments: [{
            filename: pdf.pdfName,
            content: pdf.pdfBuffer,
            contentType: 'application/pdf'
          }]
        });
        sentCount++;
      } catch (err) {
        console.error('Failed for', who, err.message);
        failed.push({ name: who, reason: err.message });
      }
    }

    res.json({ ok: true, sentCount, failed });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
