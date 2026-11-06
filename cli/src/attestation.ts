// Checking an OutLayer attestation from public data alone (R15.1): that Intel's hardware
// signed a TDX quote over exactly this task, from an OutLayer worker build OutLayer's register
// contract approves. The record comes from OutLayer's public API
// (`/attestations/by-tx/<tx>`); every field the caller relies on is then bound by the quote:
//
// - the quote (TDX, version 4, ECDSA P-256) is signed by its attestation key; that key is
//   bound into the Quoting Enclave's report, which the PCK certificate's key signs; the PCK
//   certificate chains to Intel's SGX Root CA, pinned here by its SHA-256 fingerprint; that
//   report is Intel's TDX Quoting Enclave's (MRSIGNER, ISVPRODID and attributes pinned from
//   Intel's PCS);
// - the TD isn't a debug TD (TD_ATTRIBUTES.DEBUG clear);
// - the quote's report_data is SHA-256 of the task's fields in OutLayer's order
//   (worker/src/tdx_attestation.rs: task_type, task_id LE, repo, commit, build_target,
//   wasm_hash, input_hash, output_hash, block_height LE, caller, project_id, secrets_ref,
//   timestamp LE, attached_usd; absent fields skipped), followed by 32 zero bytes;
// - the five measurements (MRTD, RTMR0-3) are on the register contract's approved list
//   (`is_measurements_approved`), read as it stands now.
//
// Not checked: Intel's TCB status and revocation lists (OutLayer's register contract checks
// them when a worker registers), and whether the measurements were approved when the job ran.
import { createHash, createPublicKey, verify, X509Certificate } from "node:crypto";

/** SHA-256 fingerprint of Intel's SGX Root CA certificate, the root of every PCK chain. */
export const INTEL_SGX_ROOT_CA_SHA256 = "44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3";

/**
 * Intel's TDX Quoting Enclave, the only enclave whose report may vouch for a TDX quote's
 * attestation key: its signer (MRSIGNER) and product ID (ISVPRODID), and the attributes it
 * must have under Intel's mask (no debug enclave). From Intel's PCS, "TD_QE" identity:
 * https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity (read Nov 5, 2026).
 * The SGX QE has the same signer but product ID 1.
 */
export const INTEL_TDX_QE = {
  mrsigner: "dc9e2a7c6f948f17474e34a7fc43ed030f7c1563f1babddf6340c82e0e54a8c5",
  isvprodid: 2,
  attributes: "11000000000000000000000000000000",
  attributesMask: "fbffffffffffffff0000000000000000",
} as const;

/** OutLayer's register contract, which approves worker measurements. */
export const OUTLAYER_REGISTER = { testnet: "worker.outlayer.testnet", mainnet: "worker.outlayer.near" } as const;

/** OutLayer's attestation record, as its API returns it. */
export interface AttestationRecord {
  task_id: number;
  task_type: string;
  tdx_quote: string;
  request_id?: number;
  transaction_hash?: string;
  repo?: string | null;
  commit?: string | null;
  build_target?: string | null;
  wasm_hash?: string | null;
  executed_wasm_sha256?: string | null;
  input_hash?: string | null;
  output_hash: string;
  block_height?: number | null;
  caller_account_id?: string | null;
  project_id?: string | null;
  secrets_ref?: string | null;
  timestamp: number;
  attached_usd?: string | number | null;
  worker_measurement?: string;
}

export interface Measurements {
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
}

export interface QuoteCheck {
  /** Every check on the quote itself passed. */
  ok: boolean;
  problems: string[];
  measurements: Measurements | null;
}

/** SHA-256 over the task's fields, as OutLayer's worker puts it in the quote's report_data. */
export function taskHash(a: AttestationRecord): Buffer {
  const h = createHash("sha256");
  const str = (s: string | number | null | undefined) => {
    if (s !== null && s !== undefined) h.update(Buffer.from(String(s), "utf8"));
  };
  const le64 = (n: number | null | undefined) => {
    if (n === null || n === undefined) return;
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(n));
    h.update(b);
  };
  str(a.task_type);
  le64(a.task_id);
  str(a.repo);
  str(a.commit);
  str(a.build_target);
  str(a.wasm_hash);
  str(a.input_hash);
  str(a.output_hash);
  le64(a.block_height);
  str(a.caller_account_id);
  str(a.project_id);
  str(a.secrets_ref);
  le64(a.timestamp);
  str(a.attached_usd);
  return h.digest();
}

const p256 = (raw: Buffer) =>
  createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(0, 32).toString("base64url"), y: raw.subarray(32, 64).toString("base64url") },
    format: "jwk",
  });

/** Check the quote's signature chain to Intel and that it was made over this task. */
export function checkQuote(a: AttestationRecord): QuoteCheck {
  const problems: string[] = [];
  const q = Buffer.from(a.tdx_quote ?? "", "base64");
  const HEADER = 48;
  const BODY = 584;
  if (q.length < HEADER + BODY + 4 || q.readUInt16LE(0) !== 4 || q.readUInt16LE(2) !== 2 || q.readUInt32LE(4) !== 0x81) {
    return { ok: false, problems: ["the quote is not an Intel TDX quote (version 4, ECDSA P-256)"], measurements: null };
  }
  const body = q.subarray(HEADER, HEADER + BODY);
  const field = (offset: number) => body.subarray(offset, offset + 48).toString("hex");
  const measurements = { mrtd: field(136), rtmr0: field(328), rtmr1: field(376), rtmr2: field(424), rtmr3: field(472) };
  // TD_ATTRIBUTES (TD report body, offset 120), bit 0: a debug TD's memory and state are open
  // to the host, so nothing it reports can be trusted.
  if ((body.readUInt8(120) & 1) !== 0) problems.push("the TD is in debug mode (TD_ATTRIBUTES.DEBUG is set)");
  try {
    const sigData = q.subarray(HEADER + BODY + 4, HEADER + BODY + 4 + q.readUInt32LE(HEADER + BODY));
    const signature = sigData.subarray(0, 64);
    const attestationKey = sigData.subarray(64, 128);
    let p = 128;
    if (sigData.readUInt16LE(p) !== 6) throw new Error("no Quoting Enclave report in the quote");
    p += 6;
    const qeReport = sigData.subarray(p, p + 384);
    const qeSignature = sigData.subarray(p + 384, p + 448);
    p += 448;
    const authLength = sigData.readUInt16LE(p);
    const authData = sigData.subarray(p + 2, p + 2 + authLength);
    p += 2 + authLength;
    if (sigData.readUInt16LE(p) !== 5) throw new Error("no PCK certificate chain in the quote");
    const pem = sigData.subarray(p + 6, p + 6 + sigData.readUInt32LE(p + 2)).toString("utf8");
    const certs = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((c) => new X509Certificate(c));
    if (certs.length < 3) throw new Error("the PCK certificate chain is incomplete");
    const [pck, platform, root] = certs as [X509Certificate, X509Certificate, X509Certificate];

    if (root.fingerprint256 !== INTEL_SGX_ROOT_CA_SHA256) problems.push("the certificate chain doesn't end at Intel's SGX Root CA");
    if (!root.verify(root.publicKey) || !platform.verify(root.publicKey) || !pck.verify(platform.publicKey)) {
      problems.push("the PCK certificate chain's signatures don't verify");
    }
    if (!verify("sha256", qeReport, { key: pck.publicKey, dsaEncoding: "ieee-p1363" }, qeSignature)) {
      problems.push("the Quoting Enclave report isn't signed by the PCK certificate");
    }
    // The report is the TDX QE's (SGX report body: ATTRIBUTES at 48, MRSIGNER at 128,
    // ISVPRODID at 256), not some other enclave on the platform.
    const attributes = qeReport.subarray(48, 64);
    const mask = Buffer.from(INTEL_TDX_QE.attributesMask, "hex");
    const masked = Buffer.from(attributes.map((b, i) => b & mask[i]!));
    const mrsigner = qeReport.subarray(128, 160).toString("hex");
    const isvprodid = qeReport.readUInt16LE(256);
    if (mrsigner !== INTEL_TDX_QE.mrsigner || isvprodid !== INTEL_TDX_QE.isvprodid || masked.toString("hex") !== INTEL_TDX_QE.attributes) {
      problems.push(`the Quoting Enclave isn't Intel's TDX QE (MRSIGNER ${mrsigner}, ISVPRODID ${isvprodid}, attributes ${attributes.toString("hex")})`);
    }
    const bound = createHash("sha256").update(attestationKey).update(authData).digest();
    const qeData = qeReport.subarray(320, 384);
    if (!bound.equals(qeData.subarray(0, 32)) || !qeData.subarray(32).every((b) => b === 0)) {
      problems.push("the attestation key isn't the one the Quoting Enclave vouches for");
    }
    if (!verify("sha256", q.subarray(0, HEADER + BODY), { key: p256(attestationKey), dsaEncoding: "ieee-p1363" }, signature)) {
      problems.push("the quote's signature doesn't verify");
    }
  } catch (e) {
    problems.push(`the quote can't be read: ${(e as Error).message}`);
  }
  const reportData = body.subarray(520, 584);
  if (!reportData.subarray(0, 32).equals(taskHash(a)) || !reportData.subarray(32).every((b) => b === 0)) {
    problems.push("the quote wasn't made over this task's fields (report_data differs)");
  }
  return { ok: problems.length === 0, problems, measurements };
}
