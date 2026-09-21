import type { BrowserContextOptions } from "@cloudflare/playwright";
import { decryptJson, encryptJson } from "./security";

export type StorageState = NonNullable<BrowserContextOptions["storageState"]>;

export class ProfileStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly encryptionKey: string,
  ) {}

  async load(accountId: string, version?: string): Promise<StorageState | undefined> {
    if (!version) return undefined;
    const object = await this.bucket.get(this.key(accountId, version));
    if (!object) throw new Error("Profile version not found");
    return decryptJson<StorageState>(await object.text(), this.encryptionKey, `${accountId}:${version}`);
  }

  async save(accountId: string, state: StorageState): Promise<string> {
    const version = `${Date.now()}-${crypto.randomUUID()}`;
    const payload = await encryptJson(state, this.encryptionKey, `${accountId}:${version}`);
    await this.bucket.put(this.key(accountId, version), payload, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { accountId, version, encrypted: "aes-gcm" },
    });
    return version;
  }

  private key(accountId: string, version: string): string {
    return `profiles/${accountId}/${version}.json.enc`;
  }
}
