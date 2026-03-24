import { getPassword, setPassword } from "cross-keychain";

const KEYCHAIN_SERVICE = "acp-signer";

function toKeychainAccount(publicKey: string): string {
  return Buffer.from(publicKey, "base64").toString("hex");
}

export async function storeSignerKey(
  publicKey: string,
  privateKey: string
): Promise<void> {
  await setPassword(KEYCHAIN_SERVICE, toKeychainAccount(publicKey), privateKey);
}

export async function loadSignerKey(publicKey: string): Promise<string | null> {
  return getPassword(KEYCHAIN_SERVICE, toKeychainAccount(publicKey));
}
