// Single source of truth for the frozen query-contract schema/compiler version.
// Bump this whenever the compiled contract shape or compiler judgement changes
// in a way that should be visible as CONTRACT_DRIFT during replay.
export const CONTRACT_COMPILER_VERSION = '1.0.0';

export default CONTRACT_COMPILER_VERSION;
