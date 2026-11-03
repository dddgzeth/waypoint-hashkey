/**
 * Solidity compilation for the deploy_contract capability. The plan carries
 * source, never bytecode: the server compiles it itself with a pinned compiler
 * (solc 0.8.28, optimizer on, "paris" EVM so the bytecode runs on every
 * supported chain, including L2s that lack newer opcodes).
 */
import { createRequire } from "node:module";
import type { Abi } from "viem";

const solc = createRequire(import.meta.url)("solc") as {
  compile(input: string): string;
  version(): string;
};

export interface CompiledContract {
  name: string;
  abi: Abi;
  bytecode: `0x${string}`;
  compilerVersion: string;
}

export class CompileError extends Error {}

/** Compiles one self-contained source file. `contractName` picks the contract; when omitted the last deployable one is used. */
export function compileSolidity(source: string, contractName?: string): CompiledContract {
  const input = {
    language: "Solidity",
    sources: { "Contract.sol": { content: source } },
    settings: {
      evmVersion: "paris",
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
  };
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) {
    throw new CompileError(errors.map((e) => e.formattedMessage.trim()).slice(0, 3).join("\n\n"));
  }
  const compiled = Object.entries(output.contracts?.["Contract.sol"] ?? {}).filter(([, c]) => c.evm.bytecode.object.length > 0);
  if (!compiled.length) throw new CompileError("The source defines no deployable contract (interfaces and abstract contracts have no bytecode)");
  const picked = contractName ? compiled.find(([name]) => name === contractName) : compiled[compiled.length - 1];
  if (!picked) {
    throw new CompileError(`Contract "${contractName}" not found. Deployable contracts: ${compiled.map(([name]) => name).join(", ")}`);
  }
  return { name: picked[0], abi: picked[1].abi, bytecode: `0x${picked[1].evm.bytecode.object}`, compilerVersion: solc.version() };
}
