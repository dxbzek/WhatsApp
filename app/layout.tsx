// Root layout: global Twilio Paste styles + the app shell (sidebar + top bar).
import "./globals.css";
import Shell from "./shell";

export const metadata = { title: "ERE Homes · WhatsApp Console", description: "ERE Homes WhatsApp inbox, templates, campaigns & billing" };

// viewport-fit=cover lets us pad against the notch/home-indicator via env(safe-area-inset-*).
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" as const };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
