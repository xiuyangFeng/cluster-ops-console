# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.25.x | Yes |
| 2.24.x | Security fixes only until the next minor |
| < 2.24 | No |

Desktop (Electron) and web mode share the same monitor server. Only tagged GitHub Releases are supported builds.

## Reporting a vulnerability

Please use GitHub Security Advisories for this repository. Do not open a public issue for unreleased credential leaks, auth bypass, or remote-command bugs.

- Target first response: 7 days
- Target remediation or public advisory for confirmed P1 issues: 30 days

Include the affected version/tag, reproduction without real passwords, and whether any host keys or tokens may already be exposed.

## Credential leak response

If a password, SSH private key, `AUTH_TOKEN`, vault token, or `config.local.json` was committed, logged, or published in a Release asset:

1. Rotate the credential immediately. Treat `mem:` references as already expired; delete any `vault:` reference and re-enter the secret.
2. Remove the file from the working tree. Do not rely on later commits to hide Git history.
3. If the leak reached a public fork or Release, revoke tokens and publish a GitHub Security Advisory.
4. Host-key changes must be confirmed by a person. Do not use `accept-new` or auto-trust a new fingerprint.

Passwords are never stored in JSON. Electron persists only `safeStorage` ciphertext under the user data directory; web mode keeps passwords in a 15-minute memory vault.

## Repository settings this file cannot enable

Enable GitHub secret scanning and push protection on the repository. Dependabot and CodeQL workflows are in `.github/`.
