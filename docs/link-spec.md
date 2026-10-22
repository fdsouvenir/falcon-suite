# Falcon Link — specification

Status: approved by Fred on 2026-10-22. Implementation started; not released.

## Purpose

Falcon Link is a separately installable suite plugin that makes known integrations easy to
connect and maintain. First integrations: **gogcli** and **m365cli** (under development).
It wraps their existing installation and authentication capabilities rather than replacing
their service clients or building a second OAuth/token implementation.

## Requirements from Fred

- Each integration first shows whether its CLI is installed.
- Show installed version and whether an update is available; provide an update action.
- Beneath tool status, provide a provider-specific login interface.
- Support multiple accounts for each integration.
- Let the person choose which scopes to authorize.
- Client application setup is not part of customer onboarding. Operators seed the client
  configuration when installing for customers.
- An installation without that configuration must clearly report that the integration is
  not set up correctly, rather than starting a login that cannot succeed.
- The goal is a pleasant customer experience, especially avoiding the difficult Microsoft
  onboarding experienced in the first Offices.
- Provide operator-only provisioning outside customer onboarding. The exact operator interface
  and protected storage contract remain implementation decisions.

## Proposed interaction

Each integration has independent tool, setup and account state:

1. **Tool:** Not installed / Installed (version) / Update available (current → available).
   A failed version check is reported as unknown or failed, never as “not installed.”
   A failed release lookup does not mean “up to date.”
2. **Setup:** Ready / Setup required / Configuration error. Missing operator configuration
   says “Google [or Microsoft] connection setup is incomplete. Contact your administrator.”
3. **Accounts:** Account identity, optional label, granted permissions and connection state.
   Actions: Add account, Reconnect, Change permissions, Disconnect.

Connecting an account:

1. Choose capabilities using understandable labels such as Mail, Calendar, Contacts and Files,
   with read-only versus write access where the CLI/provider supports that distinction.
2. Review the actual provider permissions to be requested, including mandatory baseline scopes.
3. Complete provider sign-in and consent through the flow supported by that CLI.
4. Verify the returned account identity and granted permissions before reporting Connected.

Keep requested permissions separate from verified granted permissions. Explain tenant-admin
consent requirements, cancellation, expiry and reconnect failures with a useful next action.
Never silently broaden permissions. Reducing permissions may require provider revocation and
fresh consent; changing local selections alone must not be reported as revoked access.

Adding an account must preserve existing accounts. Every operation identifies its account
explicitly; do not silently switch the CLI's global default. Tokens remain in the CLI's
supported protected storage, isolated within the Office/runtime boundary.

## Operator provisioning — approved direction

Provide an operator-only provisioning mechanism, separate from the ordinary connection page.
Seed the provider's full required application configuration, not necessarily just its ID
(Google desktop OAuth may also require a client secret; Microsoft may need audience/tenant
configuration). Never ship customer configuration or secrets in the public plugin package.

The customer page reports readiness without exposing those values. A public ClawHub install
without seeded configuration remains loadable, but the affected login action is unavailable.
The exact operator-interface access model and storage contract need defining before implementation.

## Implementation qualification still needed

- Confirm the actual m365cli executable, release source, machine-readable authentication contract,
  multi-account behavior and exact supported scopes; do not substitute the unrelated PnP CLI.
- Local gogcli source documents service selection and narrower Gmail permission modes.
  Local mogcli review source documents named profiles, workload selection and delegated
  device-code login. These are source observations, not proof of the developing m365cli contract.
- Qualify browser/remote login in a hosted Office; a callback to the Office's localhost must
  not be assumed to reach the customer's browser.
- Define supported install/update sources and platforms. Preserve account configuration and
  credentials across updates, and retain a working version if update verification fails.
- Determine available CLI/provider readbacks for connection health and granted permissions;
  report unknown when those cannot be verified.
- Choose service presets and scope defaults after checking each provider's actual capability
  mapping. Do not offer unsupported read-only controls or default to every scope.

No customer installation, account authorization, client configuration changes or release is
implied by approval of this specification.

## Delivery tracking

Parent: [Google and Microsoft onboarding #7](https://github.com/fdsouvenir/falcon-suite/issues/7).

| Issue                                                       | Deliverable                                       | Depends on    |
| ----------------------------------------------------------- | ------------------------------------------------- | ------------- |
| [#8](https://github.com/fdsouvenir/falcon-suite/issues/8)   | Standalone package, native page, read-only status | —             |
| [#9](https://github.com/fdsouvenir/falcon-suite/issues/9)   | Qualify both CLI contracts and remote login       | #8            |
| [#10](https://github.com/fdsouvenir/falcon-suite/issues/10) | Operator provisioning and readiness               | #9            |
| [#11](https://github.com/fdsouvenir/falcon-suite/issues/11) | Google multi-account consent and permissions      | #9, #10       |
| [#12](https://github.com/fdsouvenir/falcon-suite/issues/12) | Microsoft multi-account consent and permissions   | #9, #10       |
| [#13](https://github.com/fdsouvenir/falcon-suite/issues/13) | Qualified install and recoverable updates         | #9            |
| [#14](https://github.com/fdsouvenir/falcon-suite/issues/14) | Hosted Office and package acceptance              | #11, #12, #13 |

The initial foundation only probes `gog --version`. Microsoft status remains unqualified;
updates, provisioning and accounts are not implemented. Follow-up issues stay open until
their own acceptance criteria are met. No production installation is used as a test target.
