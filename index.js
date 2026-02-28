const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

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
    console.log('Sending to:', process.env.OPENCLAW_URL);
    console.log('Token:', process.env.HOOKS_TOKEN);
    const response = await fetch(process.env.OPENCLAW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HOOKS_TOKEN}`,
        'x-openclaw-token': process.env.HOOKS_TOKEN
      },
      body: JSON.stringify({
        message: `You received an email.\nFrom: ${email.from}\nSubject: ${email.subject}\nMessage: ${email.text}\n\nReply to this email when done.`,
        name: "Email",
        wakeMode: "now",
        deliver: true,
        channel: "last"
      })
    });

    const text = await response.text();
    console.log(`OpenClaw response (${response.status}): ${text}`);
    console.log(`Retry-After header: ${response.headers.get('retry-after')}`);

    try {
      return JSON.parse(text);
    } catch {
      return { response: text };
    }
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

              if (reply && reply.response && reply.response !== 'Auth required') {
                await sendReply(
                  parsed.from.text,
                  parsed.subject,
                  reply.response
                );
              } else {
                console.log('Skipping reply - invalid or empty response from OpenClaw');
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
