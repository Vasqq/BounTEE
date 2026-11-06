// A forged claim header for the R2.6 run: real fields, a block number no chain has reached.
/** An RLP block header (a flat list of byte strings) with its number, field 8, replaced. */
export function withNumber(headerHex: string, n: number): string {
  const b = Buffer.from(headerHex.slice(2), "hex");
  const len = (at: number, short: number) => {
    const p = b[at]!;
    if (p < short + 56) return { head: 1, body: p - short };
    const ll = p - short - 55;
    return { head: 1 + ll, body: Number(BigInt(`0x${b.subarray(at + 1, at + 1 + ll).toString("hex")}`)) };
  };
  const list = len(0, 0xc0);
  const items: Buffer[] = [];
  for (let at = list.head; at < list.head + list.body; ) {
    if (b[at]! < 0x80) { items.push(b.subarray(at, at + 1)); at += 1; continue; }
    const s = len(at, 0x80);
    items.push(b.subarray(at + s.head, at + s.head + s.body));
    at += s.head + s.body;
  }
  items[8] = Buffer.from(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), "0"), "hex");
  const enc = (x: Buffer, short: number) => {
    if (short === 0x80 && x.length === 1 && x[0]! < 0x80) return x;
    if (x.length < 56) return Buffer.concat([Buffer.from([short + x.length]), x]);
    const l = Buffer.from(x.length.toString(16).padStart(x.length.toString(16).length + (x.length.toString(16).length % 2), "0"), "hex");
    return Buffer.concat([Buffer.from([short + 55 + l.length]), l, x]);
  };
  return `0x${enc(Buffer.concat(items.map((x) => enc(x, 0x80))), 0xc0).toString("hex")}`;
}
