# iOS simulator testing for agents

A public GitHub Actions harness for temporary, **live** iOS simulator sessions. Agents inspect accessibility trees and screenshots, tap, type, assert results, and transfer app-container fixtures using Callstack's [agent-device](https://agent-device.dev/).

**Prototype.** Local checks and native smoke results are recorded in [docs/validation.md](docs/validation.md). Review [the privacy boundary](docs/privacy.md) before using private app builds.

The public repository holds the harness and skill. The runner receives an app over an authenticated connection; it does not check out a private repository or receive its GitHub credentials. A client-generated public key encrypts the session's connection credentials. Only this encrypted bootstrap is uploaded to Actions artifacts. App data and captures download to the agent's machine.

## Install the skill

Clone this repository, then copy `skills/ios-simulator-testing` into your agent's skills directory (for Codex, `~/.codex/skills/ios-simulator-testing`). Install its pinned dependency:

```sh
bun install --cwd ~/.codex/skills/ios-simulator-testing --frozen-lockfile
```

Invoke `$ios-simulator-testing` and ask it to test a simulator build. The skill's command helper requires Node 24+, Bun, and an authenticated `gh` CLI with permission to dispatch and cancel workflows in the harness repository.

## Run a session

Review a harness commit first; pass that exact SHA and a branch or tag pointing to it:

```sh
node skills/ios-simulator-testing/scripts/simulator.mjs start \
  --repo tingkai-c/ios-simulator-testing --ref main --sha FULL_REVIEWED_SHA
```

The JSON result identifies the private local session file. Use its path for subsequent calls:

```sh
node skills/ios-simulator-testing/scripts/simulator.mjs exec --state SESSION_JSON -- install com.example.app ./MyApp.app
node skills/ios-simulator-testing/scripts/simulator.mjs exec --state SESSION_JSON -- open com.example.app
node skills/ios-simulator-testing/scripts/simulator.mjs exec --state SESSION_JSON -- snapshot -i
node skills/ios-simulator-testing/scripts/simulator.mjs exec --state SESSION_JSON -- click @e1
node skills/ios-simulator-testing/scripts/simulator.mjs exec --state SESSION_JSON -- screenshot ./evidence.png
node skills/ios-simulator-testing/scripts/simulator.mjs stop --state SESSION_JSON
```

Sessions default to 15 minutes; configurable from 5 to 30. iOS 26.2 is the default runtime, matching the driver’s upstream CI. Set `--ios-version VERSION` or `--ios-version newest` for another installed runtime; unavailable versions fail explicitly. `--runner xcode-27` is available for apps requiring that preview toolchain. Each job owns one simulator. Run separate sessions for independent agents; keep commands serial within a session. Public workflow metadata reveals runner choice, session timing, and job status.

## App data

`state-export --bundle com.example.app --out fixture.zip` and `state-import --bundle com.example.app --file fixture.zip` accept `--state SESSION_JSON`. They close the active device session and stop the simulator while copying `Documents` and `Library`. Reopen the app and take a fresh UI snapshot afterward, allowing `--timeout 120000` for XCTest to restart after the reboot. Import replaces these directories; export first when the existing test state matters.

Fixtures are app-container ZIPs with a bundle-bound manifest. Use the same app build/runtime for reliable restoration. They exclude Keychain, App Groups, push tokens, and remote backend state. A UI `snapshot` is an accessibility tree, not an app-data checkpoint.

## Hosting and billing

Standard hosted-runner minutes for public repositories are free under GitHub's published pricing rules. That does **not** establish that an unrestricted cross-repository simulator service is permitted: [Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions) restrict hosted-runner use to development/testing associated with the repository's software project and restrict commercial Actions services. This harness has no GitHub approval or guarantee for arbitrary private workloads. Keep this distinction explicit before relying on it as a free backend.

A reusable workflow called by a private repository is [billed to the private caller](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#how-reusable-workflows-use-runners). Creating a public harness does not change that rule. Building the private simulator `.app` separately may also use private macOS minutes.

The connection uses a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), which is a third-party development transport without an uptime guarantee. No Cloudflare account is required. The agent and runner trust GitHub, Cloudflare's TLS termination, the pinned tool, and this harness's maintainers. This is not end-to-end encryption of the live tunnel payloads.
