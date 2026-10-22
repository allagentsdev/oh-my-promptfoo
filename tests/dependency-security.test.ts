import { expect, test } from "bun:test";
import { createRequire } from "node:module";

// Exercise the Forge copy used by Promptfoo's JKS/PKCS#12 loader, not a separate test pin.
const promptfooRequire = createRequire(import.meta.resolve("promptfoo"));
const jksRequire = createRequire(promptfooRequire.resolve("jks-js"));
const forge = jksRequire("node-forge");

// Published test-only RSA key from Forge's upstream regression suite:
// https://github.com/digitalbazaar/forge/blob/db05494352dd3c9a5a07c5270333dcc78866cad2/tests/unit/rsa.js
const modulus = [
  "E932AC92252F585B3A80A4DD76A897C8B7652952FE788F6EC8DD640587A1EE56",
  "47670A8AD4C2BE0F9FA6E49C605ADF77B5174230AF7BD50E5D6D6D6D28CCF0A8",
  "86A514CC72E51D209CC772A52EF419F6A953F3135929588EBE9B351FCA61CED7",
  "8F346FE00DBB6306E5C2A4C6DFC3779AF85AB417371CF34D8387B9B30AE46D7A",
  "5FF5A655B8D8455F1B94AE736989D60A6F2FD5CADBFFBD504C5A756A2E6BB5CE",
  "CC13BCA7503F6DF8B52ACE5C410997E98809DB4DC30D943DE4E812A47553DCE5",
  "4844A78E36401D13F77DC650619FED88D8B3926E3D8E319C80C744779AC5D6AB",
  "E252896950917476ECE5E8FC27D5F053D6018D91B502C4787558A002B9283DA7",
].join("");
const privateExponent = [
  "009b771db6c374e59227006de8f9c5ba85cf98c63754505f9f30939803afc149",
  "8eda44b1b1e32c7eb51519edbd9591ea4fce0f8175ca528e09939e48f37088a0",
  "7059c36332f74368c06884f718c9f8114f1b8d4cb790c63b09d46778bfdc4134",
  "8fb4cd9feab3d24204992c6dd9ea824fbca591cd64cf68a233ad0526775c9848",
  "fafa31528177e1f8df9181a8b945081106fd58bd3d73799b229575c4f3b29101",
  "a03ee1f05472b3615784d9244ce0ed639c77e8e212ab52abddf4a928224b6b6f",
  "74b7114786dd6071bd9113d7870c6b52c0bc8b9c102cfe321dac357e030ed6c5",
  "80040ca41c13d6b4967811807ef2a225983ea9f88d67faa42620f42a4f5bdbe0",
  "3b",
].join("");
const n = new forge.jsbn.BigInteger(modulus, 16);
const e = new forge.jsbn.BigInteger("3");
const publicKey = forge.pki.rsa.setPublicKey(n, e);
const digest = () => forge.md.sha256.create().update("hello world!");
const key = forge.pki.rsa.setPrivateKey(n, e, new forge.jsbn.BigInteger(privateExponent, 16));

// Private-key-generated malformed encodings test verifier acceptance, not a
// private-key-free forgery. Normal PKCS#1 padding checks remain enabled.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, content.length]), content]);
}

const oid = Buffer.from("0609608648016503040201", "hex");
const nullParameters = Buffer.from([0x05, 0x00]);
const octets = der(0x04, Buffer.from(digest().digest().getBytes(), "latin1"));
const algorithm = der(0x30, oid, nullParameters);
const canonical = der(0x30, algorithm, octets);
const garbage = Buffer.alloc(8, 0x88);
const malformed: [string, Buffer][] = [
  ["extra inner element", der(0x30, der(0x30, oid, nullParameters, der(0x02, garbage)), octets)],
  ["non-NULL parameters", der(0x30, der(0x30, oid, der(0x02, garbage)), octets)],
  ["NULL with content", der(0x30, der(0x30, oid, der(0x05, garbage)), octets)],
  [
    "nonminimal outer length",
    Buffer.concat([Buffer.from([0x30, 0x81, canonical[1]]), canonical.subarray(2)]),
  ],
  [
    "nonminimal inner length",
    der(
      0x30,
      Buffer.concat([Buffer.from([0x30, 0x81, algorithm[1]]), algorithm.subarray(2)]),
      octets,
    ),
  ],
  ["extra outer element", der(0x30, algorithm, octets, der(0x02, garbage))],
  ["trailing bytes", Buffer.concat([canonical, Buffer.from([0])])],
];

function accepts(signature: string): boolean {
  try {
    return publicKey.verify(digest().digest().getBytes(), signature);
  } catch {
    // Forge may reject malformed ASN.1 with an exception instead of false.
    return false;
  }
}

test("JKS Forge accepts valid RSA signatures but rejects changed messages", () => {
  const signature = key.sign(digest());
  expect(accepts(signature)).toBe(true);
  expect(
    publicKey.verify(forge.md.sha256.create().update("changed").digest().getBytes(), signature),
  ).toBe(false);
});

for (const [name, encoded] of malformed) {
  test(`JKS Forge rejects ${name} with valid padding (CVE-2026-85393)`, () => {
    const signature = key.sign(encoded.toString("latin1"), "NONE");
    expect(accepts(signature)).toBe(false);
  });
}

for (const [name, encoded] of [
  ["with NULL parameters", canonical],
  ["without NULL parameters", der(0x30, der(0x30, oid), octets)],
] as const) {
  test(`JKS Forge accepts canonical DigestInfo ${name}`, () => {
    const signature = key.sign(encoded.toString("latin1"), "NONE");
    expect(accepts(signature)).toBe(true);
  });
}
