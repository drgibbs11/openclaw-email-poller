const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

const imap = new Imap({
  user: process.env.ZOHO_EMAIL,
  password: process.env.ZOHO_APP_PASSWORD,
  host: process.env.IMAP_HOST,
  port: parseInt(process.env.IMAP_PORT),
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_APP_PASSWORD
  }
});

async function forwardToOpenClaw(email) {
  try {
    const response = await fetch(process.env.OPENCLAW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CLAWDBOT_GATEWAY_TOKEN}`
      },
      body: JSON.stringify({
        message: `You received an email.\nFrom: ${email.from}\nSubject: ${email.subject}\nMessage: ${email.text}\n\nReply to this email when done.`,
        replyTo: email.from
      })
    });
    return await response.json();
  } catch (err) {
    console.error('Error forwarding to OpenClaw:', err);
    return null;
  }
}

async function sendReply(to, subject, body) {
  try {
    await transporter.sendMail({
      from: process.env.ZOHO_EMAIL,
      to: to,
      subject: `Re: ${subject}`,
      html: body
    });
    console.log(`Reply sent to ${to}`);
  } catch (err) {
    console.error('Error sending reply:', err);
  }
}

function checkMail() {
  console.log('Checking for new mail...');
  
  const imapConnection = new Imap({
    user: process.env.ZOHO_EMAIL,
    password: process.env.ZOHO_APP_PASSWORD,
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT),
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  imapConnection.once('ready', () => {
    imapConnection.openBox('INBOX', false, (err) => {
      if (err) {
        console.error('Error opening inbox:', err);
        imapConnection.end();
        return;
      }
      imapConnection.search(['UNSEEN'], (err, results) => {
        if (err || !results || !results.length) {
          console.log('No new messages');
          imapConnection.end();
          return;
        }
        console.log(`Found ${results.length} unread message(s)`);
        const f = imapConnection.fetch(results, { bodies: '' });
        f.on('message', (msg) => {
          let uid;
          msg.on('body', (stream) => {
            simpleParser(stream, async (err, parsed) => {
              if (err) {
                console.error('Error parsing email:', err);
                return;
              }
              console.log(`Processing email from: ${parsed.from.text}`);
              const reply = await forwardToOpenClaw({
                from: parsed.from.text,
                subject: parsed.subject,
                text: parsed.text
              });
              if (reply) {
                await sendReply(
                  parsed.from.text,
                  parsed.subject,
                  reply.response || reply.message || JSON.stringify(reply)
                );
              }
            });
          });
          msg.once('attributes', (attrs) => {
            uid = attrs.uid;
            imapConnection.addFlags(uid, ['\\Seen'], (err) => {
              if (err) console.error('Error marking as read:', err);
            });
          });
        });
        f.once('end', () => {
          console.log('Done processing messages');
          imapConnection.end();
        });
      });
    });
  });

  imapConnection.once('error', (err) => {
    console.error('IMAP connection error:', err);
  });

  imapConnection.once('end', () => {
    console.log('IMAP connection closed');
  });

  imapConnection.connect();
}

// Poll every 2 minutes
setInterval(checkMail, 120000);
checkMail();
