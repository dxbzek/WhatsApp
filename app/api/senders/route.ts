import { NextResponse } from "next/server";
import { whatsappSenders, cleanEnv } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Available WhatsApp sender numbers (for the "send from" dropdown), plus which
// lane each belongs to: utility = the main account's number, marketing = the
// subaccount's. The UI uses this to label threads and show the Subaccount badge.
export async function GET() {
  const senders = whatsappSenders().map((s) => s.replace(/^whatsapp:/, ""));
  const utility = cleanEnv(process.env.TWILIO_WHATSAPP_FROM).replace(/^whatsapp:/, "");
  const marketing =
    cleanEnv(process.env.TWILIO_MKT_WHATSAPP_FROM).replace(/^whatsapp:/, "") ||
    senders.find((s) => s !== utility) ||
    "";
  return NextResponse.json({ senders, utility, marketing });
}
