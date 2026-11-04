// @bountee/formats: the TypeScript twin of the Rust crate in formats/src.
//
// Its tests (formats/ts/test) sit at this public interface, a seam outside J, C, T, W and E
// on purpose: a format both the Rust side (judge, contract) and the TypeScript side
// (command-line tool, web app) must read, so they check the two sides against each other,
// which no seam that drives one side can (see formats/src/lib.rs).
export * from "./formats.ts";
export { FormatError, isAccountId, isBountyName } from "./primitives.ts";
export * as pauseRole from "./pause-role.ts";
