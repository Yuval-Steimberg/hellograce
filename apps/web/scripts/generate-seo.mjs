import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "vite";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(appRoot, "public");
const buildEnv = loadEnv(process.env.NODE_ENV || "production", appRoot, "");
const siteUrl = (process.env.VITE_SITE_URL || buildEnv.VITE_SITE_URL || "https://graceglp.com").replace(/\/+$/, "");

const publicRoutes = [
  ["", "weekly", "1.0"],
  ["/features", "monthly", "0.9"],
  ["/how-it-works", "monthly", "0.9"],
  ["/pricing", "monthly", "0.9"],
  ["/faq", "monthly", "0.8"],
  ["/privacy", "monthly", "0.4"],
  ["/terms", "monthly", "0.4"],
  ["/disclaimer", "monthly", "0.4"],
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${publicRoutes.map(([path, changefreq, priority]) => `  <url>
    <loc>${siteUrl}${path || "/"}</loc>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`).join("\n")}
</urlset>
`;

const robots = `User-agent: *
Allow: /
Disallow: /admin/
Disallow: /dashboard
Disallow: /settings
Disallow: /upgrade
Disallow: /onboarding

Sitemap: ${siteUrl}/sitemap.xml

# LLM-readable product context
LLMs-txt: ${siteUrl}/llms.txt
LLMs-full-txt: ${siteUrl}/llms-full.txt
`;

await Promise.all([
  writeFile(join(publicDir, "sitemap.xml"), sitemap, "utf8"),
  writeFile(join(publicDir, "robots.txt"), robots, "utf8"),
]);
