import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Deployment to Cloudflare Workers (Phase A task A16). No incremental cache or queue yet: pages are
// rendered per request and nothing is cached across requests, which is what Phase A needs.
export default defineCloudflareConfig();
