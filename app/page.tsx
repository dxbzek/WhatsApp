// The front door. hub.erehomes.ae and the console root both land on the
// Command Centre; the WhatsApp dashboard that used to live here moved to
// /whatsapp and keeps its place in the nav.
//
// Implementation stays in app/hub/page.tsx so the page is reachable at both "/"
// and "/hub" without a second copy to keep in sync.
export { default } from "./hub/page";
