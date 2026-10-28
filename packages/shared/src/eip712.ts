import type { Address } from "viem";

/** EIP-712 type definition for a gasless release authorisation. Must match Escrow.RELEASE_TYPEHASH. */
export const RELEASE_TYPES = {
  Release: [
    { name: "escrowId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ESCROW_DOMAIN_NAME = "Escrow";
export const ESCROW_DOMAIN_VERSION = "1";

export function escrowDomain(chainId: number, verifyingContract: Address) {
  return {
    name: ESCROW_DOMAIN_NAME,
    version: ESCROW_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

export interface ReleaseMessage {
  escrowId: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** Everything a wallet needs for `signTypedData`. */
export function buildReleaseTypedData(chainId: number, verifyingContract: Address, message: ReleaseMessage) {
  return {
    domain: escrowDomain(chainId, verifyingContract),
    types: RELEASE_TYPES,
    primaryType: "Release",
    message,
  } as const;
}
