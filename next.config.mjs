/** @type {import('next').NextConfig} */
const nextConfig = {
  // Product photo uploads (Server Actions) default-cap at 1MB — raise it so
  // normal phone-camera photos (a few MB) go through.
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  // Security headers — required by the V1 Security spec (HTTPS-only posture,
  // basic hardening). Vercel already forces HTTPS at the edge; these headers
  // reinforce that in the browser and block a few common attack classes.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;