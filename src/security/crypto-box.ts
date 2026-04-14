import crypto from "node:crypto";

const IV_LENGTH = 12;

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export class CryptoBox {
  private readonly key: Buffer;

  public constructor(secret: string) {
    this.key = crypto.createHash("sha256").update(secret).digest();
  }

  public encrypt(plainText: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const cipherText = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${toBase64Url(iv)}.${toBase64Url(authTag)}.${toBase64Url(cipherText)}`;
  }

  public decrypt(payload: string): string {
    const [ivRaw, authTagRaw, cipherTextRaw] = payload.split(".");
    if (!ivRaw || !authTagRaw || !cipherTextRaw) {
      throw new Error("invalid_encrypted_payload");
    }

    const iv = fromBase64Url(ivRaw);
    const authTag = fromBase64Url(authTagRaw);
    const cipherText = fromBase64Url(cipherTextRaw);

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return plain.toString("utf8");
  }
}
