// The welcome email a new erehomes.ae newsletter subscriber gets, sent the moment they sign
// up on the popup. It lives HERE, not in the website repo, because this is the process that
// actually sends it: a second copy over there would drift the day somebody edits one of them.
//
// Redesigned 31 Aug 2026, approved by Zek. It reads as a COMPANY INTRODUCTION, following
// `Brand Guidelines/ERE Homes Company Profile.pdf` rather than an invented layout: the
// "WELCOME / 2026" masthead mirrors the brochure cover's "COMPANY PROFILE / 2026", the line
// "A boutique Dubai brokerage, built on trust" and the sentence under it are the brochure's
// own, and the three figures sit in thin outlined circles exactly as page 3 sets them.
// Every number here is published on /about/ too (18 years, AED 4B+, 500+ families) - do not
// edit one without the other, and never invent a new one.
//
// Table-based, inline styles, no <style> block and no media queries, so it survives Gmail,
// Outlook and iOS Mail. Images are HOSTED on erehomes.ae, never base64: Gmail clips a message
// over ~102KB and the clip lands mid-email. The hero is a JPEG on purpose - Outlook on Windows
// renders WebP as a broken image, and the site's own hero-palm is WebP.
//
// {{EMAIL}} and {{UNSUB_URL}} are the only tokens, and renderWelcome() fills both. Nothing
// else changes per recipient, so there is no personalisation here that can come out wrong.

const MONT = "'Montserrat',Arial,Helvetica,sans-serif";
const LOGO = "https://erehomes.ae/assets/signature/ere-logo.9a1783f7.png";
const LOGO_WHITE = "https://erehomes.ae/assets/ere-logo-white.png";
const HERO = "https://erehomes.ae/assets/imagery/hero-palm-email.jpg";

export const WELCOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Welcome to ERE Homes</title>
</head>
<body style="margin:0; padding:0; background-color:#ECEAE5;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">A boutique Dubai brokerage built on trust, and the homes that reach you first.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ECEAE5;">
<tr><td align="center" style="padding:22px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; background-color:#FFFFFF;">

<tr><td style="padding:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="padding:20px 30px 18px 30px;">
      <img src="${LOGO}" width="92" alt="ERE Homes" style="display:block; border:0; width:92px; height:auto;">
    </td>
    <td align="right" style="padding:20px 30px 18px 10px; font-family:${MONT}; font-size:9px; font-weight:bold; letter-spacing:3px; color:#6E6A63; text-transform:uppercase;">
      Welcome &nbsp;/&nbsp; 2026
    </td>
  </tr></table>
</td></tr>

<tr><td style="padding:0;">
  <img src="${HERO}" width="600" alt="Palm Jumeirah seen from a private terrace. A boutique Dubai brokerage built on trust, and new homes that reach you first." style="display:block; border:0; width:100%; max-width:600px; height:auto;">
</td></tr>

<tr><td style="padding:28px 40px 26px 40px; background-color:#141414;">
  <div style="font-family:${MONT}; font-size:10px; font-weight:bold; letter-spacing:4px; color:#9A958C; text-transform:uppercase;">Welcome to ERE Homes</div>
  <div style="font-family:${MONT}; font-size:29px; line-height:1.26; color:#FFFFFF; font-weight:300; padding-top:12px;">A boutique Dubai brokerage, <span style="font-weight:700;">built on trust.</span></div>
  <div style="font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:1.7; color:#C9C4BB; padding-top:14px;">A property decision deserves more than a sales pitch. It deserves the truth.</div>
</td></tr>

<tr><td style="padding:24px 40px 0 40px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:1.7; color:#2A2722;">
  <p style="margin:0 0 12px 0;">Thank you for signing up. From now on you get our newest homes as they reach the market, and a straight read on where Dubai prices are actually moving.</p>
  <p style="margin:0;">Reply any time, a real person answers.</p>
</td></tr>

<tr><td style="padding:30px 40px 26px 40px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td align="center" width="33%" style="padding:0 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
        <td align="center" height="118" width="118" style="width:118px; height:118px; border:1px solid #1F1C17; border-radius:59px; font-family:${MONT}; font-size:30px; font-weight:bold; color:#1F1C17; line-height:1.1; text-align:center;">18</td>
      </tr></table>
      <div style="font-family:${MONT}; font-size:9px; font-weight:bold; letter-spacing:2px; color:#6E6A63; text-transform:uppercase; padding-top:12px;">Years in the market</div>
    </td>
    <td align="center" width="33%" style="padding:0 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
        <td align="center" height="118" width="118" style="width:118px; height:118px; border:1px solid #1F1C17; border-radius:59px; font-family:${MONT}; font-size:22px; font-weight:bold; color:#1F1C17; line-height:1.1; text-align:center;">AED<br>4B+</td>
      </tr></table>
      <div style="font-family:${MONT}; font-size:9px; font-weight:bold; letter-spacing:2px; color:#6E6A63; text-transform:uppercase; padding-top:12px;">Value transacted</div>
    </td>
    <td align="center" width="33%" style="padding:0 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
        <td align="center" height="118" width="118" style="width:118px; height:118px; border:1px solid #1F1C17; border-radius:59px; font-family:${MONT}; font-size:26px; font-weight:bold; color:#1F1C17; line-height:1.1; text-align:center;">500+</td>
      </tr></table>
      <div style="font-family:${MONT}; font-size:9px; font-weight:bold; letter-spacing:2px; color:#6E6A63; text-transform:uppercase; padding-top:12px;">Families placed</div>
    </td>
  </tr></table>
</td></tr>

<tr><td align="center" style="padding:0 40px 30px 40px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td align="center" bgcolor="#141414" style="background-color:#141414;">
      <a href="https://erehomes.ae/properties-for-sale-dubai/" style="display:inline-block; padding:15px 38px; font-family:${MONT}; font-size:11px; font-weight:bold; letter-spacing:2px; text-transform:uppercase; color:#FFFFFF; text-decoration:none;">Browse homes for sale</a>
    </td>
  </tr></table>
</td></tr>

<tr><td style="padding:30px 40px 32px 40px; background-color:#F4F2ED;">
  <div style="font-family:${MONT}; font-size:10px; font-weight:bold; letter-spacing:3px; color:#6E6A63; text-transform:uppercase;">Already own in Dubai</div>
  <div style="font-family:${MONT}; font-size:23px; line-height:1.3; color:#1F1C17; font-weight:300; padding-top:10px;">Find out what your home is <span style="font-weight:700;">worth today</span></div>
  <div style="font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:1.65; color:#2A2722; padding-top:10px;">Free and no obligation, based on what is actually selling in your building. If you decide to sell, we already have buyers looking.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;"><tr>
    <td align="center" bgcolor="#141414" style="background-color:#141414;">
      <a href="https://wa.me/971543075024" style="display:inline-block; padding:15px 36px; font-family:${MONT}; font-size:11px; font-weight:bold; letter-spacing:2px; text-transform:uppercase; color:#FFFFFF; text-decoration:none;">Get my free valuation</a>
    </td>
  </tr></table>
</td></tr>

<tr><td style="padding:26px 40px 28px 40px; background-color:#141414;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td><img src="${LOGO_WHITE}" width="78" alt="ERE Homes" style="display:block; border:0; width:78px; height:auto;"></td>
    <td align="right" style="font-family:${MONT}; font-size:9px; font-weight:bold; letter-spacing:2px; text-transform:uppercase;">
      <a href="https://erehomes.ae/properties-for-sale-dubai/" style="color:#DFDCD5; text-decoration:none;">For Sale</a> &nbsp;
      <a href="https://erehomes.ae/projects/" style="color:#DFDCD5; text-decoration:none;">Projects</a> &nbsp;
      <a href="https://erehomes.ae/sell-with-us/" style="color:#DFDCD5; text-decoration:none;">Sell</a> &nbsp;
      <a href="https://erehomes.ae/blogs/" style="color:#DFDCD5; text-decoration:none;">Blog</a>
    </td>
  </tr></table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;"><tr>
    <td style="border-top:1px solid #2E2A25; padding-top:14px; font-family:Arial,Helvetica,sans-serif; font-size:11px; line-height:1.6; color:#9A958C;">
      ERE Homes Real Estate. Office 602, The Onyx Tower 2, The Greens, Dubai.<br>
      You are receiving this because you signed up at erehomes.ae with {{EMAIL}}.
      <a href="{{UNSUB_URL}}" style="color:#9A958C; text-decoration:underline;">Unsubscribe</a>
    </td>
  </tr></table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;

export const WELCOME_TEXT = `ERE HOMES
WELCOME / 2026

A BOUTIQUE DUBAI BROKERAGE, BUILT ON TRUST.

A property decision deserves more than a sales pitch. It deserves the truth.

Thank you for signing up. From now on you get our newest homes as they reach the market, and a straight read on where Dubai prices are actually moving.

Reply any time, a real person answers.

18 years in the market
AED 4B+ value transacted
500+ families placed

Browse homes for sale: https://erehomes.ae/properties-for-sale-dubai/

ALREADY OWN IN DUBAI
Find out what your home is worth today. Free and no obligation, based on what is actually selling in your building. If you decide to sell, we already have buyers looking.
Get my free valuation: https://wa.me/971543075024

--
ERE Homes Real Estate
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
