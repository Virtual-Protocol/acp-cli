import {
  AccountRole,
  buildSolTransferIx,
  type SolanaInstructionLike,
  type ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import { CliError } from "./errors";
import { createSignableMessage, getBase58Decoder } from "@solana/kit";

// Address type accepted by the SDK Solana helpers (branded), derived without a
// direct @solana/kit import.
export type SolAddr = Parameters<typeof buildSolTransferIx>[0];

const ACCOUNT_ROLE_BY_NAME: Record<string, AccountRole> = {
  writable_signer: AccountRole.WRITABLE_SIGNER,
  writable: AccountRole.WRITABLE,
  readonly_signer: AccountRole.READONLY_SIGNER,
  readonly: AccountRole.READONLY,
};

export interface SerializedSolanaInstruction {
  programAddress: string;
  accounts: { address: string; role: string }[];
  data: string;
}

export function decodeIxData(data: string): Uint8Array {
  const buf = data.startsWith("0x")
    ? Buffer.from(data.slice(2), "hex")
    : Buffer.from(data, "base64");
  return Uint8Array.from(buf);
}

export function deserializeSolanaInstructions(
  serialized: SerializedSolanaInstruction[]
): SolanaInstructionLike[] {
  return serialized.map((ix) => ({
    programAddress: ix.programAddress as SolAddr,
    accounts: ix.accounts.map((a) => {
      const role = ACCOUNT_ROLE_BY_NAME[a.role.toLowerCase()];
      if (role === undefined) {
        throw new CliError(
          `Unknown account role "${a.role}".`,
          "VALIDATION_ERROR",
          "Use writable_signer | writable | readonly_signer | readonly."
        );
      }
      return { address: a.address as SolAddr, role };
    }),
    data: decodeIxData(ix.data),
  }));
}

export interface Web3Instruction {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

function toAccountRole(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner && isWritable) return AccountRole.WRITABLE_SIGNER;
  if (isSigner) return AccountRole.READONLY_SIGNER;
  if (isWritable) return AccountRole.WRITABLE;
  return AccountRole.READONLY;
}

export async function signSolanaMessage(
  provider: ISolanaProviderAdapter,
  message: string
): Promise<string> {
  const signer = provider.getSigner();
  const signable = createSignableMessage(message);
  const [signatures] = await signer.signMessages([signable]);
  const sigBytes = signatures[signer.address];
  if (!sigBytes)
    throw new CliError("Solana message signing failed.", "API_ERROR");
  return getBase58Decoder().decode(sigBytes);
}

export function toSolanaInstructionLike(
  ix: Web3Instruction
): SolanaInstructionLike {
  return {
    programAddress: ix.programId as SolAddr,
    accounts: ix.keys.map((k) => ({
      address: k.pubkey as SolAddr,
      role: toAccountRole(k.isSigner, k.isWritable),
    })),
    data: Uint8Array.from(Buffer.from(ix.data, "base64")),
  };
}
