const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isValidAccountId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(value);
}

export function isAuthorized(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken || expectedToken.length < 24) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(header.slice(7), expectedToken);
}

export function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index % Math.max(a.length, 1)] ?? 0) ^ (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return mismatch === 0;
}

function ownedBytes(values: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(values.length));
  for (let index = 0; index < values.length; index += 1) bytes[index] = values[index] ?? 0;
  return bytes;
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return ownedBytes(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  }
  const binary = atob(value);
  const decoded = ownedBytes(Array.from(binary, (character) => character.charCodeAt(0)));
  if (decoded.length !== 32) throw new Error("PROFILE_ENCRYPTION_KEY must decode to 32 bytes");
  return decoded;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return ownedBytes(Array.from(atob(value), (character) => character.charCodeAt(0)));
}

interface EncryptedEnvelope {
  version: 1;
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export async function encryptJson(value: unknown, secret: string, aad: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", decodeKey(secret), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    plaintext,
  );
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: "AES-GCM",
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };
  return JSON.stringify(envelope);
}

export async function decryptJson<T>(payload: string, secret: string, aad: string): Promise<T> {
  const envelope = JSON.parse(payload) as EncryptedEnvelope;
  if (envelope.version !== 1 || envelope.algorithm !== "AES-GCM") {
    throw new Error("Unsupported encrypted profile format");
  }
  const key = await crypto.subtle.importKey("raw", decodeKey(secret), "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv), additionalData: encoder.encode(aad) },
    key,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(decrypted)) as T;
}

export function assertAllowedUrl(value: string, allowedHosts: ReadonlySet<string>): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
    throw new Error(`Navigation blocked: ${url.hostname}`);
  }
  return url;
}
