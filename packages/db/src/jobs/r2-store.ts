import { AwsClient } from "aws4fetch";
import { AnchorExistsError, type AnchorStore } from "./anchor";

export interface R2StoreOptions {
  /** Cloudflare account id; used to build the endpoint unless `endpoint` is given. */
  accountId?: string;
  /** Override the endpoint (tests point this at a local server). */
  endpoint?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Retries for transient failures (HTTP 5xx, 429, network errors), with backoff. Default 3.
   * Safe for write-once puts: if an attempt succeeded but its reply was lost, the retry gets
   * 412 "already exists", which the anchor job treats as a recovery (it compares the content).
   */
  retries?: number;
}

/**
 * Anchors in a Cloudflare R2 bucket, over R2's S3-compatible API, signed with aws4fetch.
 *
 * Immutability comes from two layers: this code never overwrites (`If-None-Match: *` makes an
 * existing key a 412), and the bucket should have a retention/lock rule so even a leaked key
 * cannot delete or replace anchors. The bucket rule is configured in the Cloudflare dashboard,
 * not here (done together with the owner at the end of Phase A, task A16).
 *
 * NOT yet verified against real R2: until the bucket exists it is tested against a local HTTP
 * server that checks the request is signed and shaped as R2 expects.
 */
export class R2AnchorStore implements AnchorStore {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(options: R2StoreOptions) {
    const endpoint = options.endpoint ?? (options.accountId ? `https://${options.accountId}.r2.cloudflarestorage.com` : undefined);
    if (!endpoint) throw new Error("R2AnchorStore needs an accountId or an endpoint");
    this.base = `${endpoint.replace(/\/+$/, "")}/${options.bucket}`;
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: "s3",
      region: "auto",
      retries: options.retries ?? 3,
    });
  }

  async put(key: string, body: string): Promise<void> {
    const response = await this.client.fetch(`${this.base}/${key}`, {
      method: "PUT",
      body,
      headers: { "content-type": "application/json", "if-none-match": "*" },
    });
    if (response.status === 412) throw new AnchorExistsError(key);
    if (!response.ok) throw new Error(`R2 refused the anchor ${key}: HTTP ${response.status}`);
  }

  async get(key: string): Promise<string | null> {
    const response = await this.client.fetch(`${this.base}/${key}`, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 could not read ${key}: HTTP ${response.status}`);
    return response.text();
  }
}
