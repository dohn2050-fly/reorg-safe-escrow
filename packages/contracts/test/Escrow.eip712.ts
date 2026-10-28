// Cross-checks that the EIP-712 typed data produced by viem (what the web app and relayers
// sign) hashes to exactly what the contract verifies, and that a relayed signature works.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { hashTypedData, parseEther, zeroAddress } from "viem";

const RELEASE_TYPES = {
  Release: [
    { name: "escrowId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

describe("Escrow / EIP-712 interop with viem", async () => {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, payer, payee, relayer] = await viem.getWalletClients();

  it("viem-signed typed data is accepted by releaseWithSig when relayed by a third party", async () => {
    const escrow = await viem.deployContract("Escrow", [owner!.account.address]);
    const chainId = await publicClient.getChainId();

    const deadline = BigInt((await networkHelpers.time.latest()) + 3600);
    const amount = parseEther("1");

    const createHash = await escrow.write.createEscrow(
      [payee!.account.address, zeroAddress, zeroAddress, amount, deadline],
      { account: payer!.account, value: amount },
    );
    await publicClient.waitForTransactionReceipt({ hash: createHash });

    const escrowId = 1n;
    const nonce = await escrow.read.nonces([payer!.account.address]);
    const domain = { name: "Escrow", version: "1", chainId, verifyingContract: escrow.address } as const;
    const message = { escrowId, nonce, deadline } as const;

    // 1. Off-chain digest must equal the on-chain digest.
    const offChain = hashTypedData({ domain, types: RELEASE_TYPES, primaryType: "Release", message });
    const onChain = await escrow.read.hashRelease([escrowId, nonce, deadline]);
    assert.equal(offChain, onChain, "viem and Solidity disagree on the EIP-712 digest");

    // 2. Payer signs, relayer submits and pays gas.
    const signature = await payer!.signTypedData({ domain, types: RELEASE_TYPES, primaryType: "Release", message });
    const relayHash = await escrow.write.releaseWithSig([escrowId, deadline, signature], {
      account: relayer!.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: relayHash });
    assert.equal(receipt.status, "success");

    const data = await escrow.read.getEscrow([escrowId]);
    assert.equal(data.status, 2, "status should be Released");
    assert.equal(await escrow.read.balances([payee!.account.address, zeroAddress]), amount);
    assert.equal(await escrow.read.nonces([payer!.account.address]), nonce + 1n);

    // 3. The same signature cannot be replayed.
    await assert.rejects(
      escrow.write.releaseWithSig([escrowId, deadline, signature], { account: relayer!.account }),
      /InvalidStatus/,
    );
  });
});
