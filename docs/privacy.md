# Private inputs on a public runner

## Data flow

1. The agent generates a fresh RSA-3072 keypair locally. The private key lives in an owner-only local session directory. The workflow receives only its public key, random session ID, runtime selection, and expiration budget.
2. A clean macOS job boots one simulator, prepares the pinned agent-device XCTest runner, and starts a loopback proxy plus authenticated fixture gateway. It generates a random 256-bit bearer token.
3. A Cloudflare Quick Tunnel exposes the gateway. The host encrypts the endpoint, token, run identity, simulator UDID, and expiration with a random AES-256-GCM key, wraps that key with RSA-OAEP-SHA256, and binds the envelope to the session ID as authenticated data.
4. The only public artifact is that encrypted envelope. The agent decrypts it locally and checks the exact requested run, repository, session, version, endpoint shape, and expiration. Start also checks that the dispatched workflow runs the reviewed commit.
5. The agent uploads its private simulator `.app` directly through agent-device. Screenshots, UI snapshots, app logs, and fixture ZIPs return through authenticated requests to private local destinations. They never need to enter public Actions artifacts.
6. Stop requests, absolute expiration, failure handling, and workflow cleanup terminate the tunnel and simulator. The runner VM is ephemeral; this is not a guarantee of cryptographic erasure of its storage.

## Public surface

The workflow definition, code, public key, random session ID, GitHub actor, runner choice, run time, generic status, tool-install output, encrypted envelope, and a minimal health response are public. Avoid app/repository names or test data in workflow inputs, run names, or public annotations.

No private repository token is provisioned on the runner. The job's own `GITHUB_TOKEN` has read access to this public repository. Only maintainers/collaborators with workflow dispatch rights can allocate sessions. There are no issue-comment, fork-PR, `pull_request_target`, or arbitrary checkout triggers.

## Sensitive host output

The upstream proxy **prints its bearer token even when explicitly supplied**. Child stdout/stderr, daemon state, app logs, XCTest logs/results, traces, and caches can also contain secrets or typed text. Capture child output in an owner-only temporary directory. GitHub log masking is an extra measure, not the privacy boundary. Upload only the explicitly named encrypted bootstrap file, never a directory glob of runner diagnostics.

Failure diagnostics stay on the ephemeral host. The public error is deliberately generic. A failure before the tunnel is available can therefore require reproducing with synthetic inputs. Never add raw debug artifacts to diagnose a private run.

## Trust and limits

The live connection uses TLS through Cloudflare, which terminates that TLS. Encrypting the bootstrap does not hide live app uploads and UI data from that transport provider. GitHub and the host toolchain can also access runner memory and disk. Choose another transport/host if those providers are outside the project's trust boundary.

If system DNS returns `ENOTFOUND` for an exact `*.trycloudflare.com` tunnel hostname, the bundled Node preload retries its address lookup over HTTPS through Cloudflare DNS. Other names and errors retain system DNS behavior. The connection still verifies the original tunnel hostname's TLS certificate; no system resolver settings are changed.

An installed simulator app executes host code. Treat the app and its build as trusted by the session owner; this harness is not an isolation boundary for untrusted uploaded programs. A maintainer who changes the host workflow can exfiltrate data: inspect and pin the harness commit, restrict write access, and use synthetic credentials/fixtures. Agent-device authentication is bearer access to the session, not a multi-tenant sandbox.

The fixture gateway accepts only a validated bundle ID, a fixed simulator, and bounded ZIP data. It stops the simulator before copying container files. Imports validate paths, entry types, expansion limits, and the manifest before replacing `Documents` and `Library`. This does not cover Keychain, shared App Groups, external services, or portable login restoration. Fixture import is a replacement operation on the disposable simulator.

Only the tunnel connection bundle is encrypted for public storage. Screenshots and fixtures are private because they are delivered directly to a controlled client directory. Sharing or uploading them later is a separate decision.

## Evidence

- [agent-device remote proxy](https://agent-device.dev/docs/remote-proxy): authenticated RPC, direct app upload, session leases, remote artifact downloads.
- [agent-device security model](https://agent-device.dev/docs/security-trust): sensitive outputs, host-code trust, transport/runner tokens.
- [Pinned proxy implementation](https://github.com/callstack/agent-device/blob/v0.21.36/src/cli/commands/proxy.ts): startup output includes the token.
- [GitHub reusable workflow billing](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#how-reusable-workflows-use-runners): caller context controls billing.
- [GitHub Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions): public availability does not authorize a general-purpose hosted service.
