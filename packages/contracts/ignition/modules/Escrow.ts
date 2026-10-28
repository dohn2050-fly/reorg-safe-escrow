import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys the Escrow contract. The owner defaults to the deploying account and can be
 * overridden with `--parameters '{"EscrowModule":{"owner":"0x..."}}'`.
 */
export default buildModule("EscrowModule", (m) => {
  const owner = m.getParameter("owner", m.getAccount(0));
  const escrow = m.contract("Escrow", [owner]);
  return { escrow };
});
