// The build bundles this module into dist so npm consumers run the patched
// ACPX terminal implementation, not their separately installed acpx package.
export {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  isAcpRuntimeError,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
} from "acpx/runtime";
