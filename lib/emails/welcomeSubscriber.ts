// The welcome email a new erehomes.ae newsletter subscriber gets, sent the moment they sign
// up on the popup. It lives HERE, not in the website repo, because this is the process that
// actually sends it: a second copy over there would drift the day somebody edits one of them.
//
// Designed 27 Aug 2026. Table-based, inline styles, no <style> block, no web fonts and no
// media queries, so it survives Gmail, Outlook and iOS Mail. The logo is served from
// erehomes.ae, deliberately NOT the old MailerLite CDN: that account belongs to a banned
// vendor and can disappear without warning, taking the logo out of every inbox with it.
//
// {{EMAIL}} and {{UNSUB_URL}} are the only tokens, and renderWelcome() fills both. Nothing
// else changes per recipient, so there is no personalisation here that can come out wrong.

export const WELCOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Welcome to ERE Homes</title>
</head>
<body style="margin:0;padding:0;background-color:#ECEAE5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">New Dubai listings and clear market reads, sent straight to your inbox.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ECEAE5;">
<tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#FFFFFF;">
<tr>
<td style="height:3px;line-height:3px;font-size:3px;background-color:#141414;">&nbsp;</td>
</tr>
<tr>
<td align="center" style="padding:36px 40px 24px 40px;">
<img src="https://erehomes.ae/assets/signature/ere-logo.9a1783f7.png" width="118" height="71" alt="ERE Homes" style="display:block;border:0;width:118px;max-width:118px;height:71px;">
</td>
</tr>
<tr>
<td align="center" style="padding:8px 40px 0 40px;">
<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:3px;color:#6E6A63;text-transform:uppercase;">Welcome</p>
</td>
</tr>
<tr>
<td align="center" style="padding:16px 40px 0 40px;">
<h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.35;color:#1F1C17;font-weight:300;">You are on the list. <span style="font-weight:700;">New Dubai homes come to you first.</span></h1>
</td>
</tr>
<tr>
<td style="padding:22px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.75;color:#2A2722;">
<p style="margin:0 0 16px 0;">Thank you for signing up. From now on we will send you our newest Dubai listings as they come to market, plus straight reads on where prices, demand and supply are moving.</p>
<p style="margin:0;">No daily noise. Only the listings and the market context worth your time.</p>
</td>
</tr>
<tr>
<td style="padding:28px 40px 0 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="border-top:1px solid #E4E1DB;font-size:1px;line-height:1px;">&nbsp;</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:24px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.9;color:#2A2722;">
<p style="margin:0 0 8px 0;"><strong>What you will get:</strong></p>
<p style="margin:0;">New listings, sent as they are ready.<br>
Clear reads on the Dubai market, no hype.<br>
Nothing else. You can unsubscribe at any time.</p>
</td>
</tr>
<tr>
<td align="center" style="padding:32px 40px 8px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="center" bgcolor="#141414" style="background-color:#141414;">
<a href="https://erehomes.ae/properties-for-sale-dubai/" style="display:inline-block;padding:16px 40px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">View New Listings</a>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td align="center" style="padding:20px 40px 40px 40px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6E6A63;line-height:1.6;">
No shortcuts, no pressure. Just the listings and the market context that matter.
</td>
</tr>
<tr>
<td style="padding:32px 40px;background-color:#141414;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:#DFDCD5;">
<p style="margin:0 0 10px 0;font-family:Georgia,'Times New Roman',serif;font-size:18px;letter-spacing:3px;color:#FFFFFF;">ERE HOMES</p>
<p style="margin:0 0 10px 0;">Office 602, The Onyx Tower 2, The Greens, Dubai.</p>
<p style="margin:0 0 10px 0;">You are receiving this because you signed up at erehomes.ae with {{EMAIL}}.</p>
<p style="margin:0;"><a href="{{UNSUB_URL}}" style="color:#DFDCD5;text-decoration:underline;">Unsubscribe</a></p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
`;

export const WELCOME_TEXT = `ERE HOMES

WELCOME

You are on the list. New Dubai homes come to you first.

Thank you for signing up. From now on we will send you our newest Dubai listings as they come to market, plus straight reads on where prices, demand and supply are moving.

No daily noise. Only the listings and the market context worth your time.

WHAT YOU WILL GET
- New listings, sent as they are ready.
- Clear reads on the Dubai market, no hype.
- Nothing else. You can unsubscribe at any time.

View new listings: https://erehomes.ae/properties-for-sale-dubai/

No shortcuts, no pressure. Just the listings and the market context that matter.

--
ERE HOMES
Office 602, The Onyx Tower 2, The Greens, Dubai.

You are receiving this because you signed up at erehomes.ae with {{EMAIL}}.
Unsubscribe: {{UNSUB_URL}}
`;

export function renderWelcome(email: string, unsubUrl: string): { html: string; text: string } {
  // The address is echoed back to the reader ("you signed up with x@y.com"), so it has to be
  // HTML-escaped: an address is user input, and an & or < inside one would break the markup.
  const safe = email.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fill = (s: string, addr: string) => s.split("{{EMAIL}}").join(addr).split("{{UNSUB_URL}}").join(unsubUrl);
  return { html: fill(WELCOME_HTML, safe), text: fill(WELCOME_TEXT, email) };
}
