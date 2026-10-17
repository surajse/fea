# Security

## Authorization first

`fea_ingest_target` / `fea ingest` **refuse without explicit confirmation**
(`iHaveRights` / `--i-have-rights`) that you are authorized to analyze the
target: you own it, it is open-source, or you are contracted/licensed to
inspect it. The confirmation is written to the provenance log.

## What FEA will not do

- No license-check, DRM, or activation-circumvention workflows. Ever.
- No obfuscation-stripping arms race in v0.1 (out of scope by design).
- Captured vectors are **behavioral I/O only** — FEA never asks for or stores
  decompiled internals beyond what a reader adapter supplies, and the
  clean-room firewall guarantees none of it reaches synthesis.

## Execution bounds

- Every spawned process runs through `@fea/sandbox`: wall-clock timeout,
  per-stream output caps, no shell (no shell-injection surface).
- Network is not granted by FEA; HTTP capture uses explicit request plans only.

## Secrets

- Captures and packs are scanned for common secret patterns before export;
  hits are redacted and logged. Review `parity-report.json` before sharing —
  it contains real I/O samples.

## Reporting

If you find a security issue in FEA itself, please open a GitHub issue with
the `security` label rather than posting exploit details publicly.
