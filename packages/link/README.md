# Falcon Link

A separately installable OpenClaw plugin for connecting and maintaining known integrations.
Package: `@fdsouvenir/falcon-link`; plugin id: `falcon-link`.

## Development foundation

This is not a released onboarding implementation. The native **Falcon Link** page and
`falcon_link_status` read-only tool report the installed Google CLI version using
`gog --version` (five-second timeout, bounded output, no shell). Missing executables,
failed checks and unrecognized version output are separate states. Raw CLI output is
never returned to the UI or agent.

Microsoft installation status stays unqualified until the in-development **m365cli**
contract is confirmed. It is not the unrelated PnP Microsoft 365 CLI.
Updates and existing accounts are **not checked**, not healthy or empty. Provisioning
and login are unavailable. Status reads do not install/update tools, start OAuth,
read tokens, change account defaults or modify customer configuration.

The approved requirements and linked implementation issues are in
[the specification](../../docs/link-spec.md). Client application configuration belongs
in operator provisioning, never customer onboarding or the distributed package.

## Develop

From the repository root, after `npm install --include=dev`:

```sh
npm run build --workspace @fdsouvenir/falcon-link
npm run validate --workspace @fdsouvenir/falcon-link
npm test --workspace @fdsouvenir/falcon-link
```

Native UI requires the Gateway's Custom plugin UI lab. Build and validate use the
repository-local `.openclaw-build` state, not installed production plugins.
