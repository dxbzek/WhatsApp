/** @type {import('next').NextConfig} */
const nextConfig = {
  // The WhatsApp screens moved under /whatsapp/* when the app became the ERE
  // Command Centre — the old URLs sat at the root as if messaging were the
  // whole product. Every old path is kept alive as a permanent redirect so no
  // bookmark, saved link or pasted URL 404s.
  async redirects() {
    const moved = [
      "inbox", "leads", "templates", "campaigns", "automation",
      "insights", "suppressed", "sender-health", "logs", "billing",
    ];
    return moved.flatMap((p) => [
      { source: `/${p}`, destination: `/whatsapp/${p}`, permanent: true },
      // Sub-paths too: /campaigns/history was a real link inside the app.
      { source: `/${p}/:rest*`, destination: `/whatsapp/${p}/:rest*`, permanent: true },
    ]);
  },
};
module.exports = nextConfig;
