# Locked parser dependency

`zod-3.25.76.tgz` is the unmodified npm archive identified by the root
`package-lock.json`. Zod is MIT licensed; the archive includes its original
`LICENSE` and package metadata. Source: https://registry.npmjs.org/zod/-/zod-3.25.76.tgz.

The verdict proof needs actual parser behavior without an ambient dependency
directory or an install during proof execution. A single tracked archive lets the
existing file-witness executor bind the complete package bytes without inventing
a dependency repository or widening execution capabilities. The Python definition
checks lock integrity and version, refuses transitive dependencies, validates the
bounded complete archive, and extracts into a fresh temporary directory.

A lock update deliberately makes this fixture unavailable until the archive and
proof inputs are reviewed together. This fixture does not pin the production
dependency independently of the root lockfile.

The initializer proof also uses the exact npm archives for TypeScript 6.0.3
(Apache-2.0), reflect-metadata 0.2.2 (Apache-2.0), tsyringe 4.10.0 (MIT),
neverthrow 8.2.0 (MIT), and tsyringe's nested tslib 1.14.1 (0BSD). Their
original license files remain inside each complete archive. Package-lock SHA512
integrity, package identities and dependency metadata are checked before the
archives are materialized. No npm install or package lifecycle script is run.
